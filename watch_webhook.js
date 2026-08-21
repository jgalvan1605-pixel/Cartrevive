const fs = require('fs');
const dotenv = require('dotenv');

['.env', 'cartrevive/.env', '../.env'].forEach(p => {
  if (fs.existsSync(p)) dotenv.config({ path: p });
});

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET_TENANT_ID = 'b9db0e80-eaaa-474f-8046-fa5a230d52a2';
const CHAT_ID = '1034043897';
const BOT_TOKEN = process.env.TELEGRAM_CENTRAL_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const COUNTDOWN_SECONDS = 15; // 15 segundos para verificación rápida en demo

async function sendTelegramAlert(cart) {
  const customerName = cart.customerName || 'Cliente Web';
  const totalAmount = cart.cartAmount || 0;
  const customerPhone = cart.customerPhone || 'No facilitado';
  const customerEmail = cart.customerEmail || 'No facilitado';
  const items = cart.itemsSummary || 'Artículos de prueba';
  const recoveryUrl = cart.recoveryUrl || 'https://uv14ae-xf.myshopify.com';

  const msg = `🚨 <b>¡Carrito Abandonado Confirmado!</b>\n\n` +
              `👤 <b>Cliente:</b> ${customerName}\n` +
              `💰 <b>Importe:</b> ${totalAmount} €\n` +
              `📱 <b>Teléfono:</b> ${customerPhone}\n` +
              `📧 <b>Email:</b> ${customerEmail}\n` +
              `📦 <b>Productos:</b> ${items}\n\n` +
              `⏱ <i>Buffer de espera completado. ¡Momento óptimo de contacto!</i>`;

  const buttons = [];
  if (cart.customerPhone) {
    const cleanPhone = cart.customerPhone.replace(/[^0-9]/g, '');
    buttons.push([{
      text: '💬 Contactar por WhatsApp',
      url: `https://wa.me/${cleanPhone}?text=Hola%20${encodeURIComponent(customerName)},%20vimos%20tu%20inter%C3%A9s%20en%20el%20pedido...`
    }]);
  }
  buttons.push([{ text: '🛒 Ver Carrito del Cliente', url: recoveryUrl }]);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    })
  });

  const data = await res.json();
  return data.ok;
}

async function startWatcher() {
  console.clear();
  console.log('===============================================================');
  console.log('👀 MONITOR DE WEBHOOKS CARTREVIVE ACTIVO');
  console.log('===============================================================');
  console.log(`🆔 Tenant ID:     ${TARGET_TENANT_ID}`);
  console.log(`📱 Telegram Chat: ${CHAT_ID}`);
  console.log(`🤖 Bot Token:     ${BOT_TOKEN ? '✔ Cargado' : '❌ NO DETECTADO'}`);
  console.log(`⏳ Buffer Demo:   ${COUNTDOWN_SECONDS} segundos`);
  console.log('===============================================================\n');
  console.log('👉 Ve a Shopify y pulsa "Enviar notificación de prueba"...');
  console.log('🛰 Esperando entrada de webhook...\n');

  // Asegurar configuración del tenant en DB
  await prisma.tenant.upsert({
    where: { id: TARGET_TENANT_ID },
    update: { minThreshold: 0, telegramChatId: CHAT_ID },
    create: { id: TARGET_TENANT_ID, email: 'administracion@akonfitness.com', minThreshold: 0, telegramChatId: CHAT_ID }
  });

  const seenIds = new Set();
  // Ignorar carritos antiguos
  const existing = await prisma.cartLog.findMany({
    where: { tenantId: TARGET_TENANT_ID },
    select: { id: true }
  });
  existing.forEach(c => seenIds.add(c.id));

  const pollInterval = setInterval(async () => {
    try {
      const incomingCarts = await prisma.cartLog.findMany({
        where: {
          tenantId: TARGET_TENANT_ID,
          status: 'STAGING'
        },
        orderBy: { createdAt: 'desc' },
        take: 1
      });

      if (incomingCarts.length > 0 && !seenIds.has(incomingCarts[0].id)) {
        const cart = incomingCarts[0];
        seenIds.add(cart.id);

        console.log('\n📥 ¡WEBHOOK DE SHOPIFY RECIBIDO EN DIRECTO!');
        console.log('---------------------------------------------------------------');
        console.log(`👤 Cliente:  ${cart.customerName}`);
        console.log(`💶 Importe:  ${cart.cartAmount} €`);
        console.log(`📱 Teléfono: ${cart.customerPhone || 'N/A'}`);
        console.log(`📧 Email:    ${cart.customerEmail || 'N/A'}`);
        console.log('---------------------------------------------------------------');
        console.log(`⏳ Iniciando cuenta atrás de ${COUNTDOWN_SECONDS}s para verificar si paga...\n`);

        let s = COUNTDOWN_SECONDS;
        const countdownTimer = setInterval(async () => {
          s--;
          if (s > 0) {
            process.stdout.write(`\r⏱ Verificando compra... ${s}s restantes `);
          } else {
            clearInterval(countdownTimer);
            console.log('\n\n🚨 BUFFER FINALIZADO: Abandono confirmado.');

            // Actualizar a QUALIFIED
            await prisma.cartLog.update({
              where: { id: cart.id },
              data: { status: 'QUALIFIED' }
            });

            console.log('📤 Enviando alerta interactiva a Telegram...');
            const ok = await sendTelegramAlert(cart);

            if (ok) {
              console.log('🎉 ¡MENSAJE ENVIADO CON ÉXITO A TU TELEGRAM!');
            } else {
              console.log('❌ Error al enviar el mensaje de Telegram.');
            }
            console.log('\n🛰 Continuando en modo escucha para nuevos webhooks...\n');
          }
        }, 1000);
      }
    } catch (e) {
      console.error('Error polling:', e.message);
    }
  }, 1000);
}

startWatcher();
