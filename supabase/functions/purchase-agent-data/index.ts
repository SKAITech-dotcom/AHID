import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';
import {
  resolveAgentBundlePrice,
  type AgentPricingLike,
} from '../_shared/pricing.ts';
import { DATA_NETWORKS, catalogPrice } from '../_shared/dataCatalog.ts';

const NETWORKS = new Set<string>(DATA_NETWORKS);

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

  let orderId: string | null = null;
  let providerAccepted = false;
  try {
    const { admin, user } = await requireAgent(request);

    const body = await request.json();
    const phone = String(body.phone ?? '').trim();
    const networkType = String(body.networkType ?? '').trim().toLowerCase();
    const volumeInMB = Number(body.volumeInMB);

    if (!/^0\d{9}$/.test(phone)) return json({ error: 'Enter a valid 10-digit Ghanaian phone number.' }, 400);
    if (!NETWORKS.has(networkType)) return json({ error: 'Unsupported network.' }, 400);
    if (!Number.isInteger(volumeInMB) || volumeInMB < 1024 || volumeInMB > 204800) return json({ error: 'Invalid bundle volume.' }, 400);
    const listPrice = catalogPrice(networkType, volumeInMB);
    if (!listPrice) return json({ error: 'This bundle is not available at the current agent price.' }, 400);
    // See create-public-data-payment: the real client's generics are too deep
    // for TypeScript to expand against the pricing helper's structural type.
    const pricingClient = admin as unknown as AgentPricingLike;
    // The agent's own price from the Store > Pricing tab wins over the catalog.
    const saleAmount = await resolveAgentBundlePrice(
      pricingClient, user.id, networkType, volumeInMB, listPrice,
    );
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
      return json({ error: 'This bundle is not available at the current agent price.' }, 400);
    }

    let providerCost: number;
    let dataPackage;
    try {
      dataPackage = await resolveDataPackage(networkType, volumeInMB);
    } catch (error) {
      return json({ error: errorMessage(error, 'Unable to confirm the current bundle price.') }, 502);
    }
    if (!dataPackage) return json({ error: 'Unable to confirm the current bundle price.' }, 502);
    providerCost = dataPackage.costGhs;
    if (!Number.isFinite(providerCost) || providerCost <= 0) {
      return json({ error: 'Unable to confirm the current bundle price.' }, 502);
    }

    const reference = `DATA-${crypto.randomUUID()}`;
    const { data: reservedOrder, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: user.id,
      p_reference: reference,
      p_network_type: networkType,
      p_phone: phone,
      p_volume_mb: volumeInMB,
      p_amount: saleAmount,
    });
    if (reserveError) {
      if (reserveError.message.toLowerCase().includes('insufficient')) return json({ error: 'Insufficient wallet balance.' }, 400);
      throw reserveError;
    }
    orderId = reservedOrder;

    const dispatch = await buyDataPackage(dataPackage, networkType, phone);
    const success = dispatch.success;
    providerAccepted = success;

    if (!success) {
      // Provider rejected it outright: settle as failed, which refunds.
      const { error: completeError } = await admin.rpc('complete_agent_data_order', {
        p_order_id: orderId,
        p_success: false,
        p_provider_response: dispatch.payload,
      });
      if (completeError) throw completeError;
      const { data: balanceRefunded } = await admin.from('wallets').select('balance').eq('id', user.id).maybeSingle();
      return json({ error: dispatch.failureReason || 'The bundle provider did not accept the order.', orderReference: reference, refunded: true, walletBalance: Number(balanceRefunded?.balance ?? 0) }, 502);
    }

    // Provider accepted it, which is not delivery. Record the provider order id
    // so it can be reconciled later and leave the order in 'processing'.
    const { error: dispatchError } = await admin.rpc('record_agent_data_dispatch', {
      p_order_id: orderId,
      p_provider: dispatch.provider,
      p_provider_order_id: dispatch.orderId ?? null,
      p_provider_response: dispatch.payload,
    });
    if (dispatchError) throw dispatchError;

    // The 5-character code is what the agent reads out to the customer.
    const { data: dispatched } = await admin
      .from('agent_data_orders')
      .select('short_code')
      .eq('id', orderId)
      .maybeSingle();

    const { data: wallet } = await admin.from('wallets').select('balance').eq('id', user.id).maybeSingle();
    return json({
      success: true,
      orderReference: reference,
      shortCode: dispatched?.short_code ?? null,
      providerReference: dispatch.orderId ?? null,
      // Delivery is asynchronous; the dashboard reconciles this later.
      status: 'processing',
      amount: saleAmount,
      walletBalance: Number(wallet?.balance ?? 0),
    });
  } catch (error) {
    if (orderId && !providerAccepted) {
      try {
        await adminClient().rpc('complete_agent_data_order', {
          p_order_id: orderId,
          p_success: false,
          p_provider_response: { error: errorMessage(error, 'Unexpected error') },
        });
      } catch (refundError) {
        console.error('Failed to refund reserved order:', refundError);
      }
    }
    console.error(error);
    const msg = errorMessage(error, 'Unable to complete data purchase.');
    // An absent, expired or malformed session all have to surface as 401, or
    // the client shows a generic failure instead of sending the agent to log in.
    const status = /authentication is required|session is invalid|sign in/i.test(msg)
      ? 401
      : /agent account required|verified/i.test(msg)
        ? 403
        : 500;
    return json({ error: msg }, status);
  }
});
