import { adminClient, json } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';

async function signatureFor(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function providerSucceeded(payload: Record<string, unknown>) {
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  if (payload.success === true || payload.status === true || nestedData.status === true) return true;
  const status = String(payload.status ?? nestedData.status ?? '').toLowerCase();
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) return false;
  return ['success', 'successful', 'completed'].includes(status);
}

function providerAmount(payload: Record<string, unknown>) {
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  const value = payload.api_price ?? payload.cost ?? payload.price ?? payload.amount ?? payload.costPrice
    ?? nestedData.api_price ?? nestedData.cost ?? nestedData.price ?? nestedData.amount ?? nestedData.costPrice;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!secret) return json({ error: 'Payment webhook is not configured.' }, 500);
  const payload = await request.text();
  if (request.headers.get('x-paystack-signature') !== await signatureFor(payload, secret)) return json({ error: 'Invalid signature' }, 401);
  try {
    const event = JSON.parse(payload);
    if (event.event !== 'charge.success') return json({ received: true });
    const reference = event.data?.reference;
    const admin = adminClient();

    if (event.data?.metadata?.payment_type === 'wallet_topup') {
      const { data: topup, error: topupError } = await admin.from('wallet_topups')
        .select('*').eq('payment_reference', reference).single();
      if (topupError || !topup || topup.status === 'paid') return json({ received: true });
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(topup.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }
      const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
      if (creditError) throw creditError;
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'public_data') {
      const { data: order, error: orderError } = await admin.from('public_data_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || order.status !== 'pending_payment') return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(order.sale_amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }

      const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID');
      const apiKey = Deno.env.get('DATA_API_KEY');
      if (!companyAgentId || !apiKey) throw new Error('Public data provider funding is not configured.');
      await admin.from('public_data_orders').update({ status: 'processing' }).eq('id', order.id).eq('status', 'pending_payment');

      const costResponse = await fetch('https://remadata.com/api/get-cost-price', {
        method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ networkType: order.network_type, volumeInMB: order.volume_mb }),
      });
      const costPayload = await costResponse.json().catch(() => ({}));
      const providerCost = providerAmount(costPayload);
      if (!costResponse.ok || providerCost === null) throw new Error('Unable to confirm the provider bundle price.');

      const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
      const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
        p_agent_id: companyAgentId, p_reference: providerReference, p_network_type: order.network_type,
        p_phone: order.customer_phone, p_volume_mb: order.volume_mb, p_amount: Math.round(providerCost * 100) / 100,
      });
      if (reserveError) throw reserveError;

      let success = false;
      let providerPayload: Record<string, unknown> = {};
      try {
        const providerResponse = await fetch('https://remadata.com/api/buy-data', {
          method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: providerReference, phone: order.customer_phone, volumeInMB: order.volume_mb, networkType: order.network_type }),
        });
        providerPayload = await providerResponse.json().catch(() => ({ raw: 'Invalid provider response' }));
        success = providerResponse.ok && providerSucceeded(providerPayload);
      } catch (providerError) {
        providerPayload = { error: providerError instanceof Error ? providerError.message : 'Provider request failed.' };
      }
      const { error: completeError } = await admin.rpc('complete_agent_data_order', {
        p_order_id: providerOrderId, p_success: success, p_provider_response: providerPayload,
      });
      if (completeError) throw completeError;
      await admin.rpc('mark_public_data_order', {
        p_order_id: order.id, p_status: success ? 'successful' : 'failed', p_provider_amount: providerCost,
        p_provider_reference: providerReference, p_provider_response: providerPayload,
      });
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'utility_bill' || String(reference).startsWith('UTIL-')) {
      const { data: order, error: orderError } = await admin.from('utility_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || ['paid', 'completed'].includes(order.status)) return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }

      const { error: fulfilError } = await admin.rpc('fulfil_utility_order', {
        p_order_id: order.id,
        p_provider_data: {
          paystack_reference: reference,
          channel: transaction.data?.channel,
          paid_at: transaction.data?.paid_at,
          authorization: transaction.data?.authorization,
        },
      });
      if (fulfilError) throw fulfilError;
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'airtime' || String(reference).startsWith('AIR-')) {
      const { data: order, error: orderError } = await admin.from('airtime_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || order.payment_status === 'paid') return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }

      await admin.from('airtime_orders').update({
        payment_status: 'paid',
        airtime_status: 'processing',
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);

      const dispatchResult = await dispatchAirtimeTopup({
        phone: order.recipient_phone,
        network: order.network,
        amount: Number(order.amount),
        reference,
      });

      const { error: fulfilError } = await admin.rpc('fulfil_airtime_order', {
        p_order_id: order.id,
        p_airtime_status: dispatchResult.status,
        p_provider_reference: dispatchResult.providerReference ?? null,
        p_provider_response: dispatchResult.providerResponse ?? null,
        p_failure_reason: dispatchResult.failureReason ?? null,
      });
      if (fulfilError) throw fulfilError;
      return json({ received: true });
    }

    const { data: order, error } = await admin.from('results_orders').select('*').eq('payment_reference', reference).single();
    if (error || !order) return json({ received: true });
    if (order.status === 'paid') return json({ received: true });

    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const transaction = await verified.json();
    const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
    const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
    const expectedGross = Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
    if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
      return json({ error: 'Payment verification failed.' }, 400);
    }
    const { error: fulfilError } = await admin.rpc('fulfil_result_checker_order', { p_order_id: order.id });
    if (fulfilError) throw fulfilError;
    return json({ received: true });
  } catch (error) {
    console.error(error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
