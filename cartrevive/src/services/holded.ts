import axios from 'axios';
import { ShopifyCheckoutEvent } from '../types/shopify';

const HOLDED_API_BASE = 'https://api.holded.com/api/crm/v1';

export interface TenantHoldedConfig {
  apiKey: string;
  funnelId?: string | null;
  stageId?: string | null;
  assignedAgent?: string | null;
}

export class HoldedService {
  async createOpportunity(cart: ShopifyCheckoutEvent, config: TenantHoldedConfig) {
    if (!config.apiKey) {
      console.warn('[CartRevive] Modo Simulación activo: Tenant sin API Key de Holded.');
      return { status: 'mock_success', id: `mock-${Date.now()}` };
    }

    const customerName = cart.customer 
      ? `${cart.customer.first_name} ${cart.customer.last_name}`.trim()
      : (cart.email ? cart.email.split('@')[0] : 'Cliente Carrito');

    const contactEmail = cart.email || cart.customer?.email || '';
    const contactPhone = cart.customer?.phone || '';
    const amount = parseFloat(cart.total_price);

    const productsSummary = cart.line_items
      ?.map(item => `• ${item.quantity}x ${item.title} (${item.price} ${cart.currency})`)
      .join('\n') || 'Sin detalles de artículos';

    const tags: string[] = ['CartRevive', 'Carrito Abandonado'];
    if (amount >= 500) tags.push('VIP Ticket');
    if (contactPhone) tags.push('Contacto Telefónico');

    const payload: Record<string, any> = {
      name: `Carrito #${cart.id} - ${customerName} (${amount.toFixed(2)} ${cart.currency})`,
      value: amount,
      funnelId: config.funnelId || undefined,
      stageId: config.stageId || undefined,
      tags,
      note: `🛒 ENLACE DE RECUPERACIÓN DIRECTO:\n${cart.abandoned_checkout_url}\n\n📦 ARTÍCULOS EN CESTA:\n${productsSummary}\n\n👤 DATOS DE CONTACTO:\nEmail: ${contactEmail}\nTeléfono: ${contactPhone || 'No proporcionado'}`,
      contact: {
        name: customerName,
        email: contactEmail,
        phone: contactPhone
      }
    };

    if (config.assignedAgent) {
      payload.salesChannelId = config.assignedAgent;
    }

    try {
      const response = await axios.post(`${HOLDED_API_BASE}/deals`, payload, {
        headers: {
          'key': config.apiKey,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error: any) {
      console.error(`[CartRevive] Error Holded API:`, error?.response?.data || error.message);
      throw error;
    }
  }

  // Mover oportunidad a "Ganada" cuando el pedido se completa
  async markOpportunityWon(dealId: string, apiKey: string, wonStageId?: string | null) {
    if (!apiKey || dealId.startsWith('mock-')) {
      console.log(`[CartRevive Simulación] Deal #${dealId} marcado como GANADO/RECUPERADO en Holded.`);
      return true;
    }

    try {
      const payload: Record<string, any> = { status: 'won' };
      if (wonStageId) payload.stageId = wonStageId;

      await axios.put(`${HOLDED_API_BASE}/deals/${dealId}`, payload, {
        headers: {
          'key': apiKey,
          'Content-Type': 'application/json'
        }
      });
      return true;
    } catch (error: any) {
      console.error(`[CartRevive] Error al actualizar Deal a Ganado en Holded:`, error?.response?.data || error.message);
      return false;
    }
  }
}