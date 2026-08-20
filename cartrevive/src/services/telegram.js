import axios from 'axios';
export async function sendTelegramAlert(botToken, chatId, data) {
    if (!botToken || !chatId)
        return false;
    const phoneClean = (data.customerPhone || '').replace(/[^0-9]/g, '');
    const waUrl = phoneClean.length >= 7 ? `https://wa.me/${phoneClean}` : null;
    const message = `🚨 <b>¡NUEVO CARRITO DE ALTO VALOR!</b>\n\n` +
        `💰 <b>Importe:</b> ${data.cartAmount.toFixed(2)} ${data.currency}\n` +
        `👤 <b>Cliente:</b> ${data.customerName}\n` +
        `📞 <b>Teléfono:</b> ${data.customerPhone || 'No facilitado'}\n` +
        `✉️ <b>Email:</b> ${data.customerEmail || 'No facilitado'}\n` +
        `🎯 <b>Comercial Asignado:</b> ${data.assignedAgentName || 'Equipo General'}\n` +
        `📦 <b>Artículos:</b> <i>${data.itemsSummary}</i>\n\n` +
        `⚡ <i>¡Contacta al lead en menos de 5 minutos para maximizar el cierre!</i>`;
    const inlineKeyboard = [];
    const actionRow = [];
    if (waUrl) {
        actionRow.push({ text: '💬 WhatsApp', url: waUrl });
    }
    if (data.recoveryUrl && data.recoveryUrl.startsWith('http')) {
        actionRow.push({ text: '🛒 Ver Carrito', url: data.recoveryUrl });
    }
    if (actionRow.length > 0) {
        inlineKeyboard.push(actionRow);
    }
    try {
        const payload = {
            chat_id: String(chatId),
            text: message,
            parse_mode: 'HTML'
        };
        if (inlineKeyboard.length > 0) {
            payload.reply_markup = { inline_keyboard: inlineKeyboard };
        }
        const res = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, payload);
        return res.data.ok === true;
    }
    catch (error) {
        console.error('Error enviando alerta con botones:', error.response?.data || error.message);
        // Reintento en texto plano si falla por parseo
        try {
            const plainText = message.replace(/<[^>]*>?/gm, '');
            const fallbackRes = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: String(chatId),
                text: plainText
            });
            return fallbackRes.data.ok === true;
        }
        catch (e) {
            console.error('Fallo total de envío:', e.response?.data || e.message);
            return false;
        }
    }
}
export async function sendTelegramMessage(botToken, chatId, text) {
    try {
        const res = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: String(chatId),
            text,
            parse_mode: 'HTML'
        });
        return res.data.ok === true;
    }
    catch (error) {
        console.error('Error enviando HTML, reintentando texto plano:', error.response?.data || error.message);
        try {
            const plainText = text.replace(/<[^>]*>?/gm, '');
            const retryRes = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: String(chatId),
                text: plainText
            });
            return retryRes.data.ok === true;
        }
        catch (retryError) {
            console.error('Error final enviando mensaje:', retryError.response?.data || retryError.message);
            return false;
        }
    }
}
