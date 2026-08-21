const fs = require('fs');
const dotenv = require('dotenv');

['.env', 'cartrevive/.env', '../.env'].forEach(p => {
  if (fs.existsSync(p)) dotenv.config({ path: p });
});

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET_TENANT_ID = 'b9db0e80-eaaa-474f-8046-fa5a230d52a2';
const TARGET_EMAIL = 'administracion@akonfitness.com';
const BOT_TOKEN = process.env.TELEGRAM_CENTRAL_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const COUNTDOWN_SECONDS = 15;

async function sendTelegramAlert(chatId, cart) {
  const customerName = cart.customerName || 'Cliente Web';
  const totalAmount = cart.cartAmount || 0;
  const customerPhone = cart.customerPhone || '';
  const customerEmail = cart.customerEmail || 'No facilitado';
  const items = cart.itemsSummary || 'Productos del carrito';
  const recoveryUrl = cart.recoveryUrl || 'https://uv14ae-xf.myshopify.com';

  const msg = `🚨 <b>¡Carrito Abandonado Confirmado!</b>\n\n` +
              `👤 <b>Cliente:</b> ${customerName}\n` +
              `💰 <b>Importe:</b> ${totalAmount} €\n` +
              `📱 <b>Teléfono:</b> ${customerPhone || 'No facilitado'}\n` +
              `📧 <b>Email:</b> ${customerEmail}\n` +
              `📦 <b>Productos:</b> ${items}\n\n` +
              `⏱ <i>Buffer de espera completado. ¡Momento óptimo de contacto!</i>`;

  const buttons = [];
  if (customerPhone) {
    const cleanPhone = customerPhone.replace(/[^0-9]/g, '');
    buttons.push([{
      text: '💬 Contactar por WhatsApp',
      url: `https://wa.me/${cleanPhone}?text=Hola%20${encodeURIComponent(customerName)},%20vimos%20tu%20inter%C3%A9s%20en%20el%20pedido%20de%20Akon%20Fitness...`
    }]);
  }
  buttons.push([{ text: '🛒 Ver Carrito del Cliente', url: recoveryUrl }]);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    })
  });

  const data = await res.json();
  return data.ok;
}

async function start() {
  console.clear();

  // 1. Obtener y sincronizar Tenant de Akon Fitness
  let tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { id: TARGET_TENANT_ID },
        { email: TARGET_EMAIL }
      ]
    }
  });

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        id: TARGET_TENANT_ID,
        name: 'Akon Fitness',
        email: TARGET_EMAIL,
        telegramChatId: '1034043897',
        minThreshold: 0
      }
    });
  } else {
    tenant = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        id: TARGET_TENANT_ID,
        minThreshold: 0,
        telegramChatId: tenant.telegramChatId || '1034043897'
      }
    });
  }

  console.log('===============================================================');
  console.log('👀 MONITOR DE PRUEBA EN VIVO: AKON FITNESS');
  console.log('===============================================================');
  console.log(`📧 Cuenta:        ${tenant.email}`);
  console.log(`🆔 Tenant ID:     ${tenant.id}`);
  console.log(`📱 Telegram Chat: ${tenant.telegramChatId}`);
  console.log(`🤖 Bot Token:     ${BOT_TOKEN ? '✔ Activo' : '❌ NO ENCONTRADO'}`);
  console.log(`💶 Umbral mínimo: ${tenant.minThreshold} € (Acepta cualquier prueba)`);
  console.log(`⏳ Buffer Demo:   ${COUNTDOWN_SECONDS} segundos`);
  console.log('===============================================================\n');
  console.log('👉 Ve a Shopify y pulsa "Enviar notificación de prueba"...');
  console.log('🛰 Escuchando eventos...\n');

  const seenIds = new Set();
  const existing = await prisma.cartLog.findMany({
    where: { tenantId: tenant.id },
    select: { id: true }
  });
  existing.forEach(c => seenIds.add(c.id));

  setInterval(async () => {
    try {
      const pendingCarts = await prisma.cartLog.findMany({
        where: {
          tenantId: tenant.id,
          status: 'STAGING'
        },
        orderBy: { createdAt: 'desc' },
        take: 1
      });

      if (pendingCarts.length > 0 && !seenIds.has(pendingCarts[0].id)) {
        const cart = pendingCarts[0];
        seenIds.add(cart.id);

        console.log('\n📥 ¡WEBHOOK DE SHOPIFY CAPTURADO!');
        console.log('---------------------------------------------------------------');
        console.log(`👤 Cliente:  ${cart.customerName}`);
        console.log(`💶 Importe:  ${cart.cartAmount} €`);
        console.log(`📱 Teléfono: ${cart.customerPhone || 'N/A'}`);
        console.log(`📧 Email:    ${cart.customerEmail || 'N/A'}`);
        console.log('---------------------------------------------------------------');
        console.log(`⏳ Iniciando buffer de ${COUNTDOWN_SECONDS}s para comprobar compra...\n`);

        let s = COUNTDOWN_SECONDS;
        const timer = setInterval(async () => {
          s--;
          if (s > 0) {
            process.stdout.write(`\r⏱ Verificando si entra orden... ${s}s restantes `);
          } else {
            clearInterval(timer);
            console.log('\n\n🚨 BUFFER EXPIRADO: Abandono confirmado.');

            await prisma.cartLog.update({
              where: { id: cart.id },
              data: { status: 'QUALIFIED' }
            });

            console.log('📤 Enviando notificación con botones interactivos a Telegram...');
            const ok = await sendTelegramAlert(tenant.telegramChatId, cart);

            if (ok) {
              console.log('🎉 ¡ALERTA RECIBIDA EN TU TELEGRAM!');
            } else {
              console.log('❌ Error enviando a Telegram.');
            }
            console.log('\n🛰 Esperando siguiente webhook...\n');
          }
        }, 1000);
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  }, 1000);
}

start();
