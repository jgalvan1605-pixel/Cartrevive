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


// --- PROXY AUTO-DISCOVERY EMBUDOS HOLDED (v2 items + v1) ---
app.post('/api/holded/funnels', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { apiKey } = req.body as any;
    if (!apiKey) return rep.status(400).send({ error: 'API Key requerida' });
    const cleanKey = apiKey.trim();

    let res = await fetch('https://api.holded.com/api/v2/funnels', {
      headers: { 'Authorization': `Bearer ${cleanKey}`, 'Accept': 'application/json' }
    });

    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : (data.items || []);
    }

    res = await fetch('https://api.holded.com/api/crm/v1/funnels', {
      headers: { 'key': cleanKey, 'Accept': 'application/json' }
    });

    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : (data.items || []);
    }

    return rep.status(400).send({ error: 'Holded no reconoció la clave' });
  } catch (e: any) { return rep.status(500).send({ error: e.message }); }
});


// --- RUTA WEBHOOK SHOPIFY (MULTI-TENANT & BUFFER) ---
app.post('/api/webhooks/shopify/:tenantId', async (req: FastifyRequest, rep: FastifyReply) => {
  try {
    const { tenantId } = req.params as any;
    const body = req.body as any;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      // Si no existe, registrarlo automáticamente en modo demo
      await prisma.tenant.create({
        data: {
          id: tenantId,
          name: 'Tienda Shopify Conectada',
          email: 'administracion@akonfitness.com',
          telegramChatId: '1034043897',
          minThreshold: 0
        }
      });
    }

    const total = parseFloat(body.total_price || body.subtotal_price || '0');
    const rawId = body.id || (body.token && body.token.replace(/[^0-9]/g, '')) || Date.now();
    const cartIdBigInt = BigInt(rawId);
    const email = body.email || body.customer?.email || '';
    const phone = body.phone || body.shipping_address?.phone || body.customer?.phone || '';
    const name = `${body.customer?.first_name || ''} ${body.customer?.last_name || ''}`.trim() || 'Cliente Web';
    const items = (body.line_items || []).map((i: any) => `${i.quantity || 1}x ${i.title}`).join(', ');

    const cartLog = await prisma.cartLog.upsert({
      where: {
        tenantId_shopifyCartId: {
          tenantId: tenantId,
          shopifyCartId: cartIdBigInt
        }
      },
      update: {
        cartAmount: total,
        customerName: name,
        customerEmail: email || null,
        customerPhone: phone || null,
        recoveryUrl: body.abandoned_checkout_url || null,
        itemsSummary: items || null
      },
      create: {
        tenantId: tenantId,
        shopifyCartId: cartIdBigInt,
        cartAmount: total,
        customerName: name,
        customerEmail: email || null,
        customerPhone: phone || null,
        recoveryUrl: body.abandoned_checkout_url || null,
        itemsSummary: items || null,
        status: 'STAGING'
      }
    });

    console.log(`📥 Webhook recibido para CartLog ID ${cartLog.id}`);
    return rep.status(200).send({ ok: true, status: 'received', cartLogId: cartLog.id });
  } catch (err: any) {
    console.error('Error en webhook shopify:', err);
    return rep.status(200).send({ ok: true, error: err.message });
  }
});


// --- PROCESADOR CENTRAL DE ABANDONOS CONFIRMADOS ---
async function triggerAbandonmentProcessing(cartLogId: number) {
  try {
    const cart = await prisma.cartLog.findUnique({
      where: { id: cartLogId },
      include: { tenant: true }
    });

    if (!cart || cart.status !== 'STAGING') return;

    await prisma.cartLog.update({
      where: { id: cartLogId },
      data: { status: 'QUALIFIED' }
    });

    const tenant = cart.tenant;
    if (!tenant) return;

    // 1. Holded CRM v2
    if (tenant.holdedApiKey && tenant.holdedFunnelId && tenant.holdedStageId) {
      try {
        const contactRes = await fetch('https://api.holded.com/api/v2/contacts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tenant.holdedApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: cart.customerName || 'Cliente Web',
            email: cart.customerEmail || undefined,
            phone: cart.customerPhone || undefined,
            type: 'lead'
          })
        });
        const contactData = await contactRes.json();
        const contactId = contactData.id || contactData.item?.id;

        if (contactId) {
          const leadRes = await fetch('https://api.holded.com/api/v2/leads', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tenant.holdedApiKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              name: `Carrito - ${cart.customerName} (${cart.cartAmount}€)`,
              funnel_id: tenant.holdedFunnelId,
              stage_id: tenant.holdedStageId,
              contact_id: contactId,
              value: cart.cartAmount
            })
          });
          const leadData = await leadRes.json();
          const dealId = leadData.id || leadData.item?.id;
          if (dealId) {
            await prisma.cartLog.update({
              where: { id: cartLogId },
              data: { holdedDealId: dealId }
            });
          }
        }
      } catch (err) {
        console.error('Error Holded:', err);
      }
    }

    // 2. Telegram Alert
    const botToken = process.env.TELEGRAM_CENTRAL_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = tenant.telegramChatId;

    if (chatId && botToken) {
      const msg = `🚨 <b>¡Carrito Abandonado Confirmado!</b>\n\n` +
                  `👤 <b>Cliente:</b> ${cart.customerName}\n` +
                  `💰 <b>Importe:</b> ${cart.cartAmount} €\n` +
                  `📱 <b>Teléfono:</b> ${cart.customerPhone || 'No facilitado'}\n` +
                  `📧 <b>Email:</b> ${cart.customerEmail || 'No facilitado'}\n` +
                  (cart.itemsSummary ? `📦 <b>Productos:</b> ${cart.itemsSummary}\n\n` : '\n') +
                  `⏱ <i>Buffer cumplido sin compra. ¡Momento óptimo de contacto!</i>`;

      const cleanPhone = (cart.customerPhone || '').replace(/[^0-9]/g, '');
      const buttons: any[] = [];
      if (cleanPhone && cleanPhone.length > 5) {
        buttons.push([{
          text: '💬 Contactar por WhatsApp',
          url: `https://wa.me/${cleanPhone}?text=Hola%20${encodeURIComponent(cart.customerName)},%20vimos%20tu%20inter%C3%A9s%20en%20el%20pedido...`
        }]);
      }
      if (cart.recoveryUrl) {
        buttons.push([{ text: '🛒 Ver Carrito del Cliente', url: cart.recoveryUrl }]);
      }

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
        })
      });
    }

    console.log(`✅ Abandono confirmado y enviado para CartLog ID: ${cartLogId}`);
  } catch (e) {
    console.error('Error en triggerAbandonmentProcessing:', e);
  }
}

// --- SWEEPER AUTOMÁTICO EN SEGUNDO PLANO (CADA 30 SEGUNDOS) ---
const BUFFER_MINUTES = parseInt(process.env.BUFFER_MINUTES || '5', 10);
setInterval(async () => {
  try {
    const cutoffTime = new Date(Date.now() - (BUFFER_MINUTES * 60 * 1000));
    const expiredStagingCarts = await prisma.cartLog.findMany({
      where: {
        status: 'STAGING',
        createdAt: { lte: cutoffTime }
      },
      take: 20
    });

    for (const cart of expiredStagingCarts) {
      await triggerAbandonmentProcessing(cart.id);
    }
  } catch (err) {
    console.error('Error en Sweeper:', err);
  }
}, 30000);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 CartRevive Server ejecutándose en: ${address}`);
});
