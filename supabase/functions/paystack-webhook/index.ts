import { adminClient, json } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import { fulfilStoreOrder } from '../_shared/storeOrderFulfillment.ts';

async function signatureFor(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

    // 0. Store Data Bundle Order (direct customer purchase with agent profit margin credit)
    if (event.data?.metadata?.payment_type === 'store_order' || /^STR(?:[0-9a-f]{29}|-[0-9a-f-]{36})$/i.test(String(reference))) {
      await fulfilStoreOrder(reference);
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'wallet_topup') {
      const { data: topup, error: topupError } = await admin.from('wallet_topups')
        .select('*').eq('payment_reference', reference).single();
      if (topupError || !topup || topup.status === 'paid') return json({ received: true });
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.0195;
      const expectedGross = Math.round(((Number(topup.amount) * (1 + safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }
      const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
      if (creditError) throw creditError;
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'public_data') {
      const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
      if (!baseUrl) throw new Error('Supabase function URL is not configured.');
      // Keep one fulfilment implementation for both browser returns and
      // Paystack callbacks. It verifies the amount, claims the order once, and
      // dispatches directly through the configured Swift/GrandTech account.
      const fulfilment = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-data-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const fulfilmentPayload = await fulfilment.json().catch(() => ({}));
      if (!fulfilment.ok || fulfilmentPayload?.error) {
        console.error('Paystack public data fulfilment deferred:', {
          reference,
          httpStatus: fulfilment.status,
          response: fulfilmentPayload,
        });
      }
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'utility_bill' || String(reference).startsWith('UTIL-')) {
      const { data: order, error: orderError } = await admin.from('utility_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || ['paid', 'completed', 'processing', 'failed'].includes(order.status)) return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.0195;
      const expectedGross = Number(order.gross_amount) > 0
        ? Math.round(Number(order.gross_amount) * 100)
        : Math.round(((Number(order.amount) * (1 + safeRate)) + Number.EPSILON) * 100) / 100 * 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== expectedGross || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }
      const accountCheck = await callUtilityProvider('verify', {
        service: order.bill_type, accountNumber: order.account_number, meterType: order.meter_type,
        customerPhone: order.customer_phone,
      });
      if (!accountCheck.success || !accountCheck.verified) {
        const refund = await fetch('https://api.paystack.co/refund', {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: reference }),
        });
        await admin.from('utility_orders').update({ status: 'failed', provider_response: { error: accountCheck.message || 'Account verification failed.', refund_requested: refund.ok } }).eq('id', order.id);
        return json({ received: true });
      }
      const providerResult = await callUtilityProvider('purchase', {
        service: order.bill_type, accountNumber: order.account_number, meterType: order.meter_type,
        packageName: order.package_name, amount: Number(order.amount), customerName: order.customer_name,
        customerPhone: order.customer_phone, customerEmail: order.customer_email,
        sessionId: accountCheck.sessionId, reference,
      });
      if (providerResult.pending) {
        await admin.from('utility_orders').update({
          status: 'processing',
          provider_reference: providerResult.providerReference ?? null,
          provider_response: { provider: providerResult.raw, paystack_reference: reference },
          paid_at: new Date().toISOString(),
        }).eq('id', order.id);
        return json({ received: true, pending: true });
      }
      if (!providerResult.success) {
        const refund = await fetch('https://api.paystack.co/refund', {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: reference }),
        });
        await admin.from('utility_orders').update({ status: 'failed', provider_response: { ...providerResult.raw as Record<string, unknown>, refund_requested: refund.ok } }).eq('id', order.id);
        return json({ received: true });
      }
      const completedAt = new Date().toISOString();
      const { error: fulfilError } = await admin.from('utility_orders').update({
        status: 'completed', token_code: providerResult.token ?? null,
        provider_reference: providerResult.providerReference ?? null,
        provider_response: { provider: providerResult.raw, paystack_reference: reference },
        paid_at: completedAt, completed_at: completedAt,
      }).eq('id', order.id);
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
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.0195;
      const expectedGross = Math.round(((Number(order.amount) * (1 + safeRate)) + Number.EPSILON) * 100) / 100;
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
    const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
    const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.0195;
    const expectedGross = Math.round(((Number(order.amount) * (1 + safeRate)) + Number.EPSILON) * 100) / 100;
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
