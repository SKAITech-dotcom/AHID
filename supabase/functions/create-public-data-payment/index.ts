import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buySwiftPackage, resolveSwiftPackage } from '../_shared/swiftProvider.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';

const catalog: Record<string, Record<number, number>> = {
  mtn: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    2048: 8.8, 3072: 13.2, 4096: 17.6, 5120: 22, 6144: 26.1,
    8192: 34.8, 10240: 42, 15360: 63, 20480: 84, 25600: 103.75,
    30720: 121.5, 40960: 160, 51200: 200,
  },
  telecel: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    10240: 40, 15360: 60, 20480: 78, 30720: 114, 40960: 151, 51200: 185,
  },
  airteltigo: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    1024: 4.2, 2048: 8.39, 3072: 12.58, 4096: 16.78, 5120: 20.97,
    6144: 25.17, 7168: 29.36, 8192: 33.56, 9216: 37.53, 10240: 40.84,
    15360: 60.71,
  },
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;

  try {
    const body = await request.json();
    const networkType = String(body.networkType || '').trim().toLowerCase();
    const volumeInMB = Number(body.volumeInMB);
    const customerName = String(body.name || '').trim();
    const customerEmail = String(body.email || '').trim().toLowerCase();
    const customerPhone = String(body.phone || '').trim();
    const saleAmount = catalog[networkType]?.[volumeInMB];

    if (!customerName || customerName.length > 120 || !/^\S+@\S+\.\S+$/.test(customerEmail) || !/^0\d{9}$/.test(customerPhone) || !saleAmount) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    // WALLET-FIRST: instant data is paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    reference = `PUB-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(agentId, reference, saleAmount, 'Instant data purchase', {
      service: 'instant_data',
      network_type: networkType,
      volume_mb: volumeInMB,
    });

    const { data: order, error: orderError } = await admin.from('public_data_orders').insert({
      payment_reference: reference, customer_name: customerName, customer_email: customerEmail,
      customer_phone: customerPhone, network_type: networkType, volume_mb: volumeInMB,
      sale_amount: saleAmount, status: 'pending_payment', agent_id: agentId,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID');
    if (!companyAgentId) throw new Error('Public data provider funding is not configured.');

    const swiftPackage = await resolveSwiftPackage(networkType, volumeInMB);
    if (!swiftPackage) throw new Error('Unable to confirm the provider bundle price.');
    const providerCost = Number(swiftPackage.price);
    if (!Number.isFinite(providerCost) || providerCost <= 0) throw new Error('Unable to confirm the provider bundle price.');

    const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
    const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: companyAgentId, p_reference: providerReference, p_network_type: networkType,
      p_phone: customerPhone, p_volume_mb: volumeInMB, p_amount: Math.round(providerCost * 100) / 100,
    });
    if (reserveError) throw reserveError;

    const dispatch = await buySwiftPackage(swiftPackage.id, customerPhone);
    await admin.rpc('complete_agent_data_order', {
      p_order_id: providerOrderId, p_success: dispatch.success, p_provider_response: dispatch.payload,
    });
    await admin.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: dispatch.success ? 'successful' : 'failed',
      p_provider_amount: providerCost,
      p_provider_reference: providerReference,
      p_provider_response: dispatch.payload,
    });

    if (!dispatch.success) {
      const refundedBalance = await refundWallet(agentId, reference, saleAmount, 'Instant data provider failed');
      return json({
        success: false,
        refunded: true,
        walletBalance: refundedBalance,
        orderReference: reference,
        message: `Bundle delivery failed: ${dispatch.failureReason || 'The provider did not accept the order.'} Your wallet has been refunded.`,
      }, 502);
    }

    return json({
      success: true,
      walletBalance,
      orderReference: reference,
      status: 'successful',
      message: `Your ${Math.round(volumeInMB / 1024)}GB bundle has been delivered to ${customerPhone}.`,
    });
  } catch (error) {
    console.error('Public data payment error:', error);
    if (orderId && reference) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('public_data_orders')
          .select('sale_amount, status, agent_id')
          .eq('id', orderId)
          .maybeSingle();
        if (order && !['successful'].includes(order.status)) {
          const saleAmount = Number(order.sale_amount);
          const buyerAgentId = order.agent_id ?? '';
          if (buyerAgentId && saleAmount > 0) {
            await refundWallet(buyerAgentId, reference, saleAmount, 'Instant data purchase failed').catch(() => {});
          }
          await admin.rpc('mark_public_data_order', {
            p_order_id: orderId, p_status: 'failed', p_provider_amount: null,
            p_provider_reference: null, p_provider_response: { error: errorMessage(error, 'Unexpected error') },
          });
        }
      } catch (innerError) {
        console.error('Instant data refund/rollback failed:', innerError);
      }
    }
    const msg = errorMessage(error, 'Unable to complete data purchase.');
    const status = /authentication is required|session is invalid/i.test(msg)
      ? 401
      : /agent account required/i.test(msg)
      ? 403
      : msg.toLowerCase().includes('insufficient')
      ? 400
      : 500;
    return json({ error: msg, insufficientFunds: msg.toLowerCase().includes('insufficient') || undefined }, status);
  }
});