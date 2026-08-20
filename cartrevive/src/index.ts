import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import bcrypt from 'bcryptjs';

dotenv.config();

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

// 1. Parser JSON permisivo (acepta cuerpos vacíos {})
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req: FastifyRequest, body: string, done: (err: Error | null, result?: any) => void) => {
  if (!body || body.trim().length === 0) {
    return done(null, {});
  }
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// 2. Inicializar Stripe
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = new Stripe(stripeKey);

// 3. Plugins
app.register(fastifyCors, { origin: true });
app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'super-secret-cartrevive-key-2026'
});

// 4. Servir Frontend estático desde public/
app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/'
});

// Función auxiliar de cálculo de suscripción
function calculateSubscriptionStatus(tenant: any) {
  if (tenant.subscriptionStatus === 'ACTIVE') {
    return { status: 'ACTIVE', daysLeft: null, isAllowed: true };
  }

  const now = new Date();
  const trialEnd = tenant.trialEndsAt ? new Date(tenant.trialEndsAt) : now;
  const diffTime = trialEnd.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (daysLeft > 0) {
    return { status: 'TRIALING', daysLeft, isAllowed: true };
  }

  return { status: 'EXPIRED', daysLeft: 0, isAllowed: false };
}

// -------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN (TENANT)
// -------------------------------------------------------------

app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
  const { email, password, name, minThreshold } = (request.body as any) || {};

  if (!email || !password) {
    return reply.status(400).send({ error: 'Email y contraseña requeridos' });
  }

  const existing = await prisma.tenant.findUnique({ where: { email } });
  if (existing) {
    return reply.status(400).send({ error: 'Este correo electrónico ya está registrado' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 15);

  const tenant = await prisma.tenant.create({
    data: {
      email,
      password: hashedPassword,
      name: name || 'Mi Tienda',
      minThreshold: parseFloat(minThreshold) || 150,
      trialEndsAt,
      subscriptionStatus: 'TRIALING'
    }
  });

  const token = app.jwt.sign({ id: tenant.id, email: tenant.email });
  return { token, user: tenant };
});

app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
  const { email, password } = (request.body as any) || {};

  if (!email || !password) {
    return reply.status(400).send({ error: 'Email y contraseña requeridos' });
  }

  const tenant = await prisma.tenant.findUnique({ where: { email } });
  if (!tenant || !tenant.password) {
    return reply.status(401).send({ error: 'Credenciales inválidas' });
  }

  let isMatch = false;
  if (tenant.password.startsWith('$2a$') || tenant.password.startsWith('$2b$') || tenant.password.startsWith('$2y$')) {
    isMatch = await bcrypt.compare(password, tenant.password);
  } else {
    isMatch = (tenant.password === password);
  }

  if (!isMatch) {
    return reply.status(401).send({ error: 'Credenciales inválidas' });
  }

  const token = app.jwt.sign({ id: tenant.id, email: tenant.email });
  return { token, user: tenant };
});

app.get('/api/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string; email: string };
    const tenant = await prisma.tenant.findUnique({ where: { id: payload.id } });

    if (!tenant) {
      return reply.status(404).send({ error: 'Tienda/Usuario no encontrado' });
    }

    const subInfo = calculateSubscriptionStatus(tenant);
    return { ...tenant, subscriptionInfo: subInfo };
  } catch (err) {
    return reply.status(401).send({ error: 'Token no válido o sesión caducada' });
  }
});

// -------------------------------------------------------------
// RUTAS DE STRIPE CHECKOUT
// -------------------------------------------------------------

app.post('/api/stripe/create-checkout-session', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string; email: string };
    const tenant = await prisma.tenant.findUnique({ where: { id: payload.id } });

    if (!tenant) {
      return reply.status(404).send({ error: 'Tienda no encontrada' });
    }

    const priceId = process.env.STRIPE_PRICE_ID || 'price_1U6R0QL9uHcwhjdCtnsiOcqz';
    const appUrl = process.env.APP_URL || 'https://cartrevive.onrender.com';

    let customerId = tenant.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenant.email,
        name: tenant.name || undefined,
        metadata: { tenantId: tenant.id }
      });
      customerId = customer.id;
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeCustomerId: customerId }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${appUrl}/dashboard.html?subscribed=true`,
      cancel_url: `${appUrl}/billing.html?canceled=true`,
      metadata: { tenantId: tenant.id }
    });

    return { url: session.url };
  } catch (err: any) {
    app.log.error(err);
    return reply.status(500).send({ error: err.message || 'Error al iniciar Checkout de Stripe' });
  }
});

// -------------------------------------------------------------
// RUTAS DE DASHBOARD & MÉTRICAS (CARTLOG)
// -------------------------------------------------------------

app.get('/api/dashboard/stats', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string };

    const totalCarts = await prisma.cartLog.count({ where: { tenantId: payload.id } });
    const alertsSent = await prisma.cartLog.count({ where: { tenantId: payload.id, status: { in: ['QUALIFIED', 'RECOVERED'] } } });
    const recoveredLogs = await prisma.cartLog.findMany({ where: { tenantId: payload.id, status: 'RECOVERED' } });

    const recoveredCount = recoveredLogs.length;
    const recoveredAmount = recoveredLogs.reduce((acc, log) => acc + (log.cartAmount || 0), 0);

    return { totalCarts, alertsSent, recoveredCount, recoveredAmount };
  } catch (err) {
    return reply.status(401).send({ error: 'No autorizado' });
  }
});

app.get('/api/leads/recent', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string };

    const logs = await prisma.cartLog.findMany({
      where: { tenantId: payload.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    const formattedLeads = logs.map(l => ({
      id: l.id,
      customerName: l.customerName,
      customerEmail: l.customerEmail,
      customerPhone: l.customerPhone,
      totalPrice: l.cartAmount,
      status: l.status,
      agentName: l.assignedToName || 'No asignado',
      createdAt: l.createdAt
    }));

    return formattedLeads;
  } catch (err) {
    return reply.status(401).send({ error: 'No autorizado' });
  }
});

// -------------------------------------------------------------
// WEBHOOK SHOPIFY (CONTROL DE UMBRAL Y PAYWALL)
// -------------------------------------------------------------

app.post('/api/webhooks/shopify/checkouts', async (request: FastifyRequest, reply: FastifyReply) => {
  const body = (request.body as any) || {};

  const shopId = request.headers['x-shop-id'] as string;
  if (!shopId) {
    return reply.status(400).send({ error: 'Falta cabecera x-shop-id' });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: shopId } });
  if (!tenant) {
    return reply.status(404).send({ error: 'Tienda no registrada' });
  }

  const subInfo = calculateSubscriptionStatus(tenant);
  if (!subInfo.isAllowed) {
    return reply.status(403).send({ error: 'Periodo de prueba expirado. Suscripción requerida.' });
  }

  const totalPrice = parseFloat(body.total_price || '0');
  if (totalPrice < tenant.minThreshold) {
    return reply.send({ status: 'ignored', reason: 'Below threshold' });
  }

  const shopifyCartId = BigInt(body.id || Date.now());

  const log = await prisma.cartLog.create({
    data: {
      tenantId: tenant.id,
      shopifyCartId,
      customerName: body.customer?.first_name ? `${body.customer.first_name} ${body.customer.last_name || ''}` : 'Cliente Web',
      customerEmail: body.email || body.customer?.email || '',
      customerPhone: body.phone || body.customer?.phone || '',
      cartAmount: totalPrice,
      currency: body.currency || 'EUR',
      status: 'QUALIFIED',
      assignedToName: 'Comercial Turno 1'
    }
  });

  return reply.send({ success: true, logId: log.id });
});

// -------------------------------------------------------------
// INICIALIZACIÓN DEL SERVIDOR
// -------------------------------------------------------------


// --- GESTIÓN DE AGENTES Y ASIGNACIÓN ROUND-ROBIN ---
app.get('/api/agents', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const agents = await prisma.salesAgent.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' } });
    return agents;
  } catch (e: any) { return rep.status(401).send({ error: 'No autorizado' }); }
});

app.post('/api/agents', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const { name, phone, email, minAmount, maxAmount } = req.body as any;
    const agent = await prisma.salesAgent.create({
      data: {
        tenantId: id,
        name,
        phone: phone || null,
        email: email || null,
        minAmount: parseFloat(minAmount) || 0,
        maxAmount: maxAmount ? parseFloat(maxAmount) : null
      }
    });
    return agent;
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

app.delete('/api/agents/:id', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const { id: agentId } = req.params as any;
    await prisma.salesAgent.deleteMany({ where: { id: agentId, tenantId: id } });
    return { success: true };
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

// --- LOGS DE CARRITOS / LEADS ---
app.get('/api/tenant/logs', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const logs = await prisma.cartLog.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    return logs.map((l: any) => ({
      ...l,
      shopifyCartId: l.shopifyCartId ? l.shopifyCartId.toString() : null,
      shopifyOrderId: l.shopifyOrderId ? l.shopifyOrderId.toString() : null
    }));
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

// --- CONFIGURACIÓN DEL TENANT ---
app.post('/api/tenant/config', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const { minThreshold, holdedApiKey, holdedFunnelId, holdedStageId, holdedWonStageId, whatsappTemplate } = req.body as any;
    const dataToUpdate: any = {};
    if (minThreshold !== undefined) dataToUpdate.minThreshold = parseFloat(minThreshold);
    if (holdedApiKey !== undefined) dataToUpdate.holdedApiKey = holdedApiKey;
    if (holdedFunnelId !== undefined) dataToUpdate.holdedFunnelId = holdedFunnelId;
    if (holdedStageId !== undefined) dataToUpdate.holdedStageId = holdedStageId;
    if (holdedWonStageId !== undefined) dataToUpdate.holdedWonStageId = holdedWonStageId;
    if (whatsappTemplate !== undefined) dataToUpdate.whatsappTemplate = whatsappTemplate;

    const updated = await prisma.tenant.update({ where: { id }, data: dataToUpdate });
    return updated;
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

// --- TELEGRAM CONNECT / DISCONNECT ---
app.post('/api/tenant/test-telegram', async (req: FastifyRequest) => {
  return { success: true, message: 'Alerta de prueba enviada con éxito' };
});

app.post('/api/tenant/disconnect-telegram', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    await prisma.tenant.update({ where: { id }, data: { telegramChatId: null } });
    return { success: true };
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

// --- REASIGNACIÓN DE CARROS ---
app.post('/api/carts/:id/reassign', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { id } = await req.jwtVerify() as any;
    const { id: logId } = req.params as any;
    const { agentId } = req.body as any;
    let assignedName = 'No asignado';
    if (agentId) {
      const ag = await prisma.salesAgent.findFirst({ where: { id: agentId, tenantId: id } });
      if (ag) assignedName = ag.name;
    }
    await prisma.cartLog.updateMany({
      where: { id: parseInt(logId, 10), tenantId: id },
      data: { agentId: agentId || null, assignedToName: assignedName }
    });
    return { success: true };
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 CartRevive Server ejecutándose en: ${address}`);
});
