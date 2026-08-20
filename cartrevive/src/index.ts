import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

dotenv.config();

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

// 1. Desactivar el parser estricto por defecto y permitir JSON vacío
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

// 3. Plugins: CORS y JWT
app.register(fastifyCors, { origin: true });
app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'super-secret-cartrevive-key-2026'
});

// 4. Servir Frontend estático desde public/
app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/'
});

// Función auxiliar para estado de suscripción
function calculateSubscriptionStatus(user: any) {
  if (user.subscriptionStatus === 'ACTIVE') {
    return { status: 'ACTIVE', daysLeft: null, isAllowed: true };
  }

  const now = new Date();
  const trialEnd = user.trialEndsAt ? new Date(user.trialEndsAt) : now;
  const diffTime = trialEnd.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (daysLeft > 0) {
    return { status: 'TRIALING', daysLeft, isAllowed: true };
  }

  return { status: 'EXPIRED', daysLeft: 0, isAllowed: false };
}

// -------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN
// -------------------------------------------------------------

app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
  const { email, password, name, minThreshold } = (request.body as any) || {};

  if (!email || !password) {
    return reply.status(400).send({ error: 'Email y contraseña requeridos' });
  }

  const existing = await (prisma as any).user.findUnique({ where: { email } });
  if (existing) {
    return reply.status(400).send({ error: 'Este correo electrónico ya está registrado' });
  }

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 15);

  const user = await (prisma as any).user.create({
    data: {
      email,
      password,
      name: name || 'Mi Tienda',
      minThreshold: parseFloat(minThreshold) || 150,
      trialEndsAt,
      subscriptionStatus: 'TRIALING'
    }
  });

  const token = app.jwt.sign({ id: user.id, email: user.email });
  return { token, user };
});

app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
  const { email, password } = (request.body as any) || {};

  const user = await (prisma as any).user.findUnique({ where: { email } });
  if (!user || user.password !== password) {
    return reply.status(401).send({ error: 'Credenciales inválidas' });
  }

  const token = app.jwt.sign({ id: user.id, email: user.email });
  return { token, user };
});

app.get('/api/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string; email: string };
    const user = await (prisma as any).user.findUnique({ where: { id: payload.id } });

    if (!user) {
      return reply.status(404).send({ error: 'Usuario no encontrado' });
    }

    const subInfo = calculateSubscriptionStatus(user);
    return { ...user, subscriptionInfo: subInfo };
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
    const user = await (prisma as any).user.findUnique({ where: { id: payload.id } });

    if (!user) {
      return reply.status(404).send({ error: 'Usuario no encontrado' });
    }

    const priceId = process.env.STRIPE_PRICE_ID || 'price_1U6R0QL9uHcwhjdCtnsiOcqz';
    const appUrl = process.env.APP_URL || 'https://cartrevive.onrender.com';

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
      await (prisma as any).user.update({
        where: { id: user.id },
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
      metadata: { userId: user.id }
    });

    return { url: session.url };
  } catch (err: any) {
    app.log.error(err);
    return reply.status(500).send({ error: err.message || 'Error al iniciar Checkout de Stripe' });
  }
});

// -------------------------------------------------------------
// RUTAS DE DASHBOARD Y MÉTRICAS
// -------------------------------------------------------------

app.get('/api/dashboard/stats', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string };

    const totalCarts = await (prisma as any).cartLead.count({ where: { userId: payload.id } });
    const alertsSent = await (prisma as any).cartLead.count({ where: { userId: payload.id, status: { in: ['NOTIFIED', 'RECOVERED'] } } });
    const recoveredLeads = await (prisma as any).cartLead.findMany({ where: { userId: payload.id, status: 'RECOVERED' } });

    const recoveredCount = recoveredLeads.length;
    const recoveredAmount = recoveredLeads.reduce((acc: number, lead: any) => acc + (lead.totalPrice || 0), 0);

    return { totalCarts, alertsSent, recoveredCount, recoveredAmount };
  } catch (err) {
    return reply.status(401).send({ error: 'No autorizado' });
  }
});

app.get('/api/leads/recent', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
    const payload = request.user as { id: string };

    const leads = await (prisma as any).cartLead.findMany({
      where: { userId: payload.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    return leads;
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

  const user = await (prisma as any).user.findUnique({ where: { id: shopId } });
  if (!user) {
    return reply.status(404).send({ error: 'Tienda no registrada' });
  }

  const subInfo = calculateSubscriptionStatus(user);
  if (!subInfo.isAllowed) {
    return reply.status(403).send({ error: 'Periodo de prueba expirado. Suscripción requerida.' });
  }

  const totalPrice = parseFloat(body.total_price || '0');
  if (totalPrice < user.minThreshold) {
    return reply.send({ status: 'ignored', reason: 'Below threshold' });
  }

  const lead = await (prisma as any).cartLead.create({
    data: {
      userId: user.id,
      customerName: body.customer?.first_name ? `${body.customer.first_name} ${body.customer.last_name || ''}` : 'Cliente Web',
      customerEmail: body.email || body.customer?.email || '',
      customerPhone: body.phone || body.customer?.phone || '',
      totalPrice,
      status: 'NOTIFIED',
      agentName: 'Carlos (Round-Robin)'
    }
  });

  return reply.send({ success: true, leadId: lead.id });
});

// -------------------------------------------------------------
// INICIO DEL SERVIDOR
// -------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 CartRevive Server ejecutándose en: ${address}`);
});
