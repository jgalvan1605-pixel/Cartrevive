export interface TelegramAlertData {
  cartId: string | number;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  cartAmount: number;
  currency: string;
  itemsSummary: string;
  assignedAgentName: string | null;
  recoveryUrl: string | null;
}

export async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  data: TelegramAlertData
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  const phoneClean = (data.customerPhone || '').replace(/[^0-9+]/g, '');
  const waUrl = phoneClean
    ? `https://wa.me/${phoneClean.replace('+', '')}?text=Hola%20${encodeURIComponent(data.customerName || '')},%20te%20contacto%20sobre%20tu%20pedido%20pendiente`
    : null;

  const message = `🚨 <b>¡NUEVO CARRITO DE ALTO VALOR!</b>

💰 <b>Importe:</b> ${data.cartAmount.toFixed(2)} ${data.currency}
👤 <b>Cliente:</b> ${data.customerName}
📞 <b>Teléfono:</b> ${data.customerPhone || 'No facilitado'}
✉️ <b>Email:</b> ${data.customerEmail || 'No facilitado'}
🎯 <b>Comercial Asignado:</b> ${data.assignedAgentName || 'Equipo General'}
📦 <b>Artículos:</b> <i>${data.itemsSummary}</i>

⚡ <i>¡Contacta al lead en menos de 5 minutos para maximizar el cierre!</i>`;

  const inlineKeyboard: any[] = [];
  const actionRow: any[] = [];

  if (waUrl) {
    actionRow.push({ text: '💬 WhatsApp Directo', url: waUrl });
  }
  if (data.customerPhone) {
    actionRow.push({ text: '📞 Llamar', url: `tel:${phoneClean}` });
  }
  if (data.recoveryUrl) {
    actionRow.push({ text: '🛒 Ver Carrito', url: data.recoveryUrl });
  }

  if (actionRow.length > 0) {
    inlineKeyboard.push(actionRow);
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
      })
    });

    const result = await res.json();
    return result.ok === true;
  } catch (error) {
    console.error('Error enviando notificación a Telegram:', error);
    return false;
  }
}