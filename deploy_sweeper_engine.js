const fs = require('fs');
const { execSync } = require('child_process');

let code = fs.readFileSync('cartrevive/src/index.ts', 'utf8');

// Añadir función centralizada de procesamiento y Sweeper en background
const sweeperEngine = `
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
            'Authorization': \`Bearer \${tenant.holdedApiKey}\`,
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
              'Authorization': \`Bearer \${tenant.holdedApiKey}\`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              name: \`Carrito - \${cart.customerName} (\${cart.cartAmount}€)\`,
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
      const msg = \`🚨 <b>¡Carrito Abandonado Confirmado!</b>\\n\\n\` +
                  \`👤 <b>Cliente:</b> \${cart.customerName}\\n\` +
                  \`💰 <b>Importe:</b> \${cart.cartAmount} €\\n\` +
                  \`📱 <b>Teléfono:</b> \${cart.customerPhone || 'No facilitado'}\\n\` +
                  \`📧 <b>Email:</b> \${cart.customerEmail || 'No facilitado'}\\n\` +
                  (cart.itemsSummary ? \`📦 <b>Productos:</b> \${cart.itemsSummary}\\n\\n\` : '\\n') +
                  \`⏱ <i>Buffer cumplido sin compra. ¡Momento óptimo de contacto!</i>\`;

      const cleanPhone = (cart.customerPhone || '').replace(/[^0-9]/g, '');
      const buttons: any[] = [];
      if (cleanPhone && cleanPhone.length > 5) {
        buttons.push([{
          text: '💬 Contactar por WhatsApp',
          url: \`https://wa.me/\${cleanPhone}?text=Hola%20\${encodeURIComponent(cart.customerName)},%20vimos%20tu%20inter%C3%A9s%20en%20el%20pedido...\`
        }]);
      }
      if (cart.recoveryUrl) {
        buttons.push([{ text: '🛒 Ver Carrito del Cliente', url: cart.recoveryUrl }]);
      }

      await fetch(\`https://api.telegram.org/bot\${botToken}/sendMessage\`, {
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

    console.log(\`✅ Abandono confirmado y enviado para CartLog ID: \${cartLogId}\`);
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
`;

// Asegurar que no se duplique y se inserte antes del puerto
if (!code.includes('triggerAbandonmentProcessing')) {
  code = code.replace("const PORT = parseInt(process.env.PORT", sweeperEngine + "\nconst PORT = parseInt(process.env.PORT");
  fs.writeFileSync('cartrevive/src/index.ts', code);
}

execSync('git add -A && git commit -m "feat(sweeper): background resilient buffer sweeper" && git push origin main', { stdio: 'inherit' });
console.log('🚀 Despliegue enviado a Render con Sweeper automático.');
