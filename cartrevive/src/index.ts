import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyJwt from '@fastify/jwt';
import path from 'path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { ShopifyCheckoutEvent } from './types/shopify';
import { HoldedService } from './services/holded';
import { sendTelegramAlert, sendTelegramMessage } from './services/telegram';
import { prisma } from './db';

dotenv.config();

const app = Fastify({ logger: true });
const holdedService = new HoldedService();

app.register(cors, { origin: '*' });
app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'cartrevive_super_secret_jwt_key_2026'
});

app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/',
});

app.decorate('authenticate', async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Sesión no válida o expirada' });
  }
});

// Función auxiliar para limpiar tokens de espacios o caracteres invisibles
function cleanBotToken(token?: string | null): string {
  if (!token) return '8620405434:AAH_3bm8Gvo_BJ6b6nUCXJPK36cLDkPLJV8';
  return token.replace(/[^\x20-\x7E]/g, '').trim();
}

// Health check
app.get('/api/health', async () => ({ status: 'ok', version: '2.0.0-telegram-autolink' }));

// Auth: Register
app.post('/api/auth/register', async (request, reply) => {
  const { name, email, password, minThreshold } = request.body as any;
  if (!name || !email || !password) return reply.status(400).send({ error: 'Faltan datos obligatorios' });

  const existing = await prisma.tenant.findUnique({ where: { email } });
  if (existing) return reply.status(400).send({ error: 'El email ya está registrado' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const tenant = await prisma.tenant.create({
    data: { name, email, password: hashedPassword, minThreshold: minThreshold ? parseFloat(minThreshold) : 150.0 }
  });

  const token = app.jwt.sign({ id: tenant.id, email: tenant.email });
  return reply.status(201).send({ token, tenant });
});

// Auth: Login
app.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body as any;
  const tenant = await prisma.tenant.findUnique({ where: { email } });
  if (!tenant || !tenant.password) return reply.status(401).send({ error: 'Credenciales inválidas' });

  const valid = await bcrypt.compare(password, tenant.password);
  if (!valid) return reply.status(401).send({ error: 'Credenciales inválidas' });

  const token = app.jwt.sign({ id: tenant.id, email: tenant.email });
  return reply.send({ token, tenant });
});

app.get('/api/auth/me', { preHandler: [(app as any).authenticate] }, async (request: any) => {
  return prisma.tenant.findUnique({
    where: { id: request.user.id },
    include: { agents: { orderBy: { createdAt: 'asc' } } }
  });
});

app.post('/api/tenant/config', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const updated = await prisma.tenant.update({
    where: { id: request.user.id },
    data: request.body
  });
  return reply.send({ status: 'updated', tenant: updated });
});

// Desvincular Telegram
app.post('/api/tenant/disconnect-telegram', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const updated = await prisma.tenant.update({
    where: { id: request.user.id },
    data: { telegramChatId: null }
  });
  return reply.send({ status: 'disconnected', tenant: updated });
});

// Test Alerta Telegram
app.post('/api/tenant/test-telegram', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const rawToken = request.body.botToken || (request.user?.id ? (await prisma.tenant.findUnique({ where: { id: request.user.id } }))?.telegramBotToken : null);
  const botToken = cleanBotToken(rawToken || process.env.TELEGRAM_BOT_TOKEN);
  const chatId = String(request.body.chatId || '').trim();

  if (!chatId) return reply.status(400).send({ error: 'Falta Chat ID' });

  const ok = await sendTelegramAlert(botToken, chatId, {
    cartId: 'DEMO-999',
    customerName: 'Cliente de Prueba VIP',
    customerPhone: '+34600112233',
    customerEmail: 'prueba@tienda.com',
    cartAmount: 1450.00,
    currency: 'EUR',
    itemsSummary: '1x Máquina Pro Series (Prueba Flash)',
    assignedAgentName: 'Prueba de Sistema',
    recoveryUrl: 'https://cartrevive.onrender.com'
  });

  if (!ok) return reply.status(400).send({ error: 'No se pudo enviar el mensaje a Telegram.' });
  return reply.send({ status: 'success', message: '¡Notificación de prueba enviada a Telegram con éxito!' });
});

// WEBHOOK OFICIAL DE TELEGRAM: AUTO-VINCULACIÓN POR DEEP-LINK (/start <tenantId>)
app.post('/api/telegram/webhook', async (request: any, reply) => {
  const update = request.body;
  const botToken = cleanBotToken(process.env.TELEGRAM_BOT_TOKEN);

  if (update && update.message && update.message.text) {
    const text: string = update.message.text.trim();
    const chatId: number = update.message.chat.id;
    const senderName = update.message.from?.first_name || 'Comercial';

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const startParam = parts[1]; // tenantId

      if (startParam) {
        try {
          const tenant = await prisma.tenant.findUnique({ where: { id: startParam } });
          if (tenant) {
            await prisma.tenant.update({
              where: { id: tenant.id },
              data: {
                telegramChatId: String(chatId),
                telegramBotToken: botToken
              }
            });

            // Enviar mensaje directo con confirmación de enlace
            await sendTelegramMessage(
              botToken,
              chatId,
              `✅ <b>¡Conexión completada con éxito!</b>\n\nHola ${senderName}, este chat ha quedado vinculado a la cuenta de <b>${tenant.name}</b>.\n\nA partir de este instante recibirás aquí las alertas de carritos abandonados de alto valor con botones de llamada y WhatsApp directo.`
            );

            return reply.send({
              method: 'sendMessage',
              chat_id: chatId,
              text: `✅ <b>¡Conexión completada con éxito!</b>\n\nHola ${senderName}, este chat ha quedado vinculado a la cuenta de <b>${tenant.name}</b>.\n\nA partir de este instante recibirás aquí las alertas de carritos abandonados de alto valor con botones de llamada y WhatsApp directo.`,
              parse_mode: 'HTML'
            });
          }
        } catch (err) {
          console.error('Error vinculando Telegram:', err);
        }
      }

      await sendTelegramMessage(
        botToken,
        chatId,
        `👋 <b>Bienvenido al Bot de CartRevive</b>\n\nPara vincular tu cuenta, abre tu panel en <a href="https://cartrevive.onrender.com/integrations.html">Integraciones</a> y pulsa en <b>Vincular mi Telegram en 1 Clic</b>.`
      );

      return reply.send({
        method: 'sendMessage',
        chat_id: chatId,
        text: `👋 <b>Bienvenido al Bot de CartRevive</b>\n\nPara vincular tu cuenta, abre tu panel en <a href="https://cartrevive.onrender.com/integrations.html">Integraciones</a> y pulsa en <b>Vincular mi Telegram en 1 Clic</b>.`,
        parse_mode: 'HTML'
      });
    }
  }

  return reply.send({ status: 'ok' });
});

// Reset carritos
app.post('/api/webhooks/shopify/:tenantId/reset', async (request, reply) => {
  const { tenantId } = request.params as { tenantId: string };
  await prisma.cartLog.deleteMany({ where: { tenantId } });
  await prisma.salesAgent.updateMany({
    where: { tenantId },
    data: { lastAssignedAt: null }
  });
  return reply.send({ status: 'success', message: 'Carritos reseteados' });
});

// CRUD Comerciales
app.get('/api/agents', { preHandler: [(app as any).authenticate] }, async (request: any) => {
  return prisma.salesAgent.findMany({
    where: { tenantId: request.user.id },
    include: { _count: { select: { assignedCarts: true } } },
    orderBy: { createdAt: 'asc' }
  });
});

app.post('/api/agents', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const { name, email, phone, minAmount, maxAmount } = request.body;
  if (!name) return reply.status(400).send({ error: 'El nombre es obligatorio' });

  const agent = await prisma.salesAgent.create({
    data: {
      tenantId: request.user.id,
      name,
      email: email || null,
      phone: phone || null,
      minAmount: minAmount !== undefined && minAmount !== '' ? parseFloat(minAmount) : 0,
      maxAmount: maxAmount !== undefined && maxAmount !== '' && maxAmount !== null ? parseFloat(maxAmount) : null
    }
  });
  return reply.status(201).send(agent);
});

app.delete('/api/agents/:id', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const { id } = request.params;
  await prisma.salesAgent.deleteMany({
    where: { id, tenantId: request.user.id }
  });
  return reply.send({ status: 'deleted' });
});

app.post('/api/carts/:id/reassign', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
  const cartId = parseInt(request.params.id);
  const { agentId } = request.body;

  let assignedToName: string | null = null;
  if (agentId) {
    const agent = await prisma.salesAgent.findFirst({
      where: { id: agentId, tenantId: request.user.id }
    });
    if (agent) assignedToName = agent.name;
  }

  const updatedCart = await prisma.cartLog.update({
    where: { id: cartId },
    data: { agentId: agentId || null, assignedToName }
  });

  return reply.send({ status: 'reassigned', cart: updatedCart });
});

app.get('/api/tenant/logs', { preHandler: [(app as any).authenticate] }, async (request: any) => {
  const logs = await prisma.cartLog.findMany({
    where: { tenantId: request.user.id },
    include: { agent: true },
    orderBy: { createdAt: 'desc' },
    take: 100
  });

  return logs.map(log => ({
    ...log,
    shopifyCartId: log.shopifyCartId.toString(),
    shopifyOrderId: log.shopifyOrderId ? log.shopifyOrderId.toString() : null
  }));
});

// WEBHOOK SHOPIFY: ABANDONOS DE CARRITO
app.post('/api/webhooks/shopify/:tenantId', async (request, reply) => {
  const { tenantId } = request.params as { tenantId: string };
  const payload = request.body as ShopifyCheckoutEvent;
  const cartAmount = parseFloat(payload.total_price || '0');

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { agents: { where: { isActive: true } } }
  });

  if (!tenant || !tenant.isActive) return reply.status(404).send({ error: 'Tenant inactivo' });

  const customerName = payload.customer 
    ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim() || 'Cliente Anónimo'
    : 'Cliente Anónimo';

  const customerEmail = payload.email || payload.customer?.email || null;
  const customerPhone = payload.customer?.phone || null;
  const itemsSummary = payload.line_items
    ?.map(item => `${item.quantity}x ${item.title} (${item.price} ${payload.currency})`)
    .join(', ') || 'Sin artículos';

  // 1. Comprobar Umbral Mínimo
  if (cartAmount < tenant.minThreshold) {
    await prisma.cartLog.upsert({
      where: { tenantId_shopifyCartId: { tenantId: tenant.id, shopifyCartId: BigInt(payload.id) } },
      update: { status: 'IGNORED', cartAmount },
      create: {
        tenantId: tenant.id,
        shopifyCartId: BigInt(payload.id),
        customerName,
        customerEmail,
        customerPhone,
        cartAmount,
        currency: payload.currency,
        status: 'IGNORED',
        recoveryUrl: payload.abandoned_checkout_url,
        itemsSummary
      }
    });
    return reply.status(200).send({ status: 'ignored', reason: 'Below threshold' });
  }

  // 2. Round Robin de Comerciales
  const eligibleAgents = tenant.agents.filter(a => {
    const minOk = cartAmount >= a.minAmount;
    const maxOk = a.maxAmount === null || a.maxAmount === undefined || cartAmount <= a.maxAmount;
    return minOk && maxOk;
  });

  let selectedAgent = null;

  if (eligibleAgents.length > 0) {
    eligibleAgents.sort((a, b) => {
      if (!a.lastAssignedAt && !b.lastAssignedAt) return a.createdAt.getTime() - b.createdAt.getTime();
      if (!a.lastAssignedAt) return -1;
      if (!b.lastAssignedAt) return 1;
      return a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    });
    selectedAgent = eligibleAgents[0];
  } else if (tenant.agents.length > 0) {
    const allAgents = [...tenant.agents].sort((a, b) => {
      if (!a.lastAssignedAt && !b.lastAssignedAt) return a.createdAt.getTime() - b.createdAt.getTime();
      if (!a.lastAssignedAt) return -1;
      if (!b.lastAssignedAt) return 1;
      return a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    });
    selectedAgent = allAgents[0];
  }

  const assignedAgentId = selectedAgent ? selectedAgent.id : null;
  const assignedAgentName = selectedAgent ? selectedAgent.name : null;

  if (selectedAgent) {
    await prisma.salesAgent.update({
      where: { id: selectedAgent.id },
      data: { lastAssignedAt: new Date() }
    });
  }

  try {
    const holdedResult = await holdedService.createOpportunity(payload, {
      apiKey: tenant.holdedApiKey || '',
      funnelId: tenant.holdedFunnelId,
      stageId: tenant.holdedStageId,
      assignedAgent: assignedAgentName
    });

    const holdedDealId = holdedResult?.id ? String(holdedResult.id) : 'mock-deal-id';

    await prisma.cartLog.upsert({
      where: { tenantId_shopifyCartId: { tenantId: tenant.id, shopifyCartId: BigInt(payload.id) } },
      update: {
        status: 'QUALIFIED',
        holdedDealId,
        cartAmount,
        agentId: assignedAgentId,
        assignedToName: assignedAgentName
      },
      create: {
        tenantId: tenant.id,
        shopifyCartId: BigInt(payload.id),
        customerName,
        customerEmail,
        customerPhone,
        cartAmount,
        currency: payload.currency,
        status: 'QUALIFIED',
        holdedDealId,
        agentId: assignedAgentId,
        assignedToName: assignedAgentName,
        recoveryUrl: payload.abandoned_checkout_url,
        itemsSummary
      }
    });

    // 3. Telegram Push Garantizado con Await y Sanitización
    const activeToken = cleanBotToken(tenant.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN);
    const targetChatId = tenant.telegramChatId ? tenant.telegramChatId.trim() : null;

    if (activeToken && targetChatId) {
      try {
        await sendTelegramAlert(activeToken, targetChatId, {
          cartId: payload.id,
          customerName,
          customerPhone,
          customerEmail,
          cartAmount,
          currency: payload.currency,
          itemsSummary,
          assignedAgentName,
          recoveryUrl: payload.abandoned_checkout_url
        });
        console.log(`[Telegram] Alerta de carrito entregada a chat ID: ${targetChatId}`);
      } catch (tgErr: any) {
        console.error('[Telegram] Error enviando alerta:', tgErr.response?.data || tgErr.message);
      }
    }

    return reply.status(200).send({
      status: 'success',
      cartId: payload.id,
      cartAmount,
      assignedTo: assignedAgentName
    });
  } catch (error: any) {
    return reply.status(500).send({ status: 'error', message: 'Error procesando lead' });
  }
});

// WEBHOOK SHOPIFY: PEDIDOS PAGADOS
app.post('/api/webhooks/shopify/:tenantId/orders', async (request, reply) => {
  const { tenantId } = request.params as { tenantId: string };
  const order = request.body as any;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return reply.status(404).send({ error: 'Tenant no encontrado' });

  const checkoutId = order.checkout_id ? BigInt(order.checkout_id) : null;
  const orderEmail = order.email || order.customer?.email;

  let cart = null;
  if (checkoutId) {
    cart = await prisma.cartLog.findFirst({
      where: { tenantId, shopifyCartId: checkoutId, status: 'QUALIFIED' }
    });
  }

  if (!cart && orderEmail) {
    cart = await prisma.cartLog.findFirst({
      where: { tenantId, customerEmail: orderEmail, status: 'QUALIFIED' },
      orderBy: { createdAt: 'desc' }
    });
  }

  if (cart) {
    await prisma.cartLog.update({
      where: { id: cart.id },
      data: {
        status: 'RECOVERED',
        shopifyOrderId: BigInt(order.id),
        recoveredAt: new Date()
      }
    });

    if (cart.holdedDealId) {
      await holdedService.markOpportunityWon(
        cart.holdedDealId,
        tenant.holdedApiKey || '',
        tenant.holdedWonStageId
      );
    }

    return reply.status(200).send({ status: 'recovered', cartId: cart.id, orderId: order.id });
  }

  return reply.status(200).send({ status: 'ignored', message: 'No match' });
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`CartRevive Core listo en puerto ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();