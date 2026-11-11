import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from '../_shared/hubtelPayments.ts';
import { hubtelWalletAmountMatches, normalizeHubtel } from '../_shared/paymentGateway.ts';

const PUBLIC_AIRTIME_REFERENCE = /^PAI[0-9a-f]{29}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loadOrder(admin: ReturnType<typeof adminClient>, reference: string) {
  const { data, error } = await admin.from('airtime_orders')
    .select('id, payment_reference, public_access_token, short_code, recipient_phone, network, amount, gross_amount, payment_method, payment_status, airtime_status, provider_reference, provider_response, failure_reason, created_at')
    .eq('payment_reference', reference)
    .is('agent_id', null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markPaymentFailed(
  admin: ReturnType<typeof adminClient>,
  order: Record<string, unknown>,
  reason: string,
  payload?: unknown,
) {
  const stored = asRecord(order.provider_response);
  const { error } = await admin.from('airtime_orders').update({
    payment_status: 'failed',
    airtime_status: 'failed',
    failure_reason: reason,
    provider_response: {
      ...stored,
      paymentVerification: { state: 'failed', reason, payload: asRecord(payload), checkedAt: new Date().toISOString() },
    },
    updated_at: new Date().toISOString(),
  }).eq('id', order.id).in('payment_status', ['pending_payment', 'paid']);
  if (error) throw error;
}

function responseFor(order: Record<string, unknown>, status: string, message?: string) {
  return {
    success: status === 'delivered',
    status,
    orderCode: order.short_code,
    reference: order.payment_reference,
    phone: order.recipient_phone,
    network: order.network,
    amount: Number(order.amount || 0),
    message: message || (status === 'delivered'
      ? 'Airtime delivered successfully.'
      : status === 'processing'
        ? 'Payment confirmed. Airtime delivery is being confirmed.'
        : 'Airtime order failed.'),
  };
}

/** Confirms a guest Hubtel payment, then claims and dispatches airtime once. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  let reference = '';
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    reference = String(body.reference || '').trim();
    if (!PUBLIC_AIRTIME_REFERENCE.test(reference)) {
      return json({ success: false, error: 'A valid airtime payment reference is required.' }, 400);
    }

    const admin = adminClient();
    const order = await loadOrder(admin, reference);
    if (!order || order.payment_method !== 'hubtel') return json({ success: false, error: 'Airtime order not found.' }, 404);
    if (order.airtime_status === 'delivered') return json(responseFor(order, 'delivered'));
    if (order.airtime_status === 'failed' || order.payment_status === 'failed') {
      return json(responseFor(order, 'failed', order.failure_reason ? String(order.failure_reason) : undefined));
    }

    let paymentConfirmed = false;
    const storedPayload = asRecord(order.provider_response);
    // The checkout-init response is stored under `checkout`; it is not proof
    // that the customer paid. Only a root/Data callback payload may settle.
    const isCallbackPayload = !storedPayload.checkout && (
      storedPayload.ResponseCode !== undefined
      || storedPayload.responseCode !== undefined
      || storedPayload.Status !== undefined
      || storedPayload.status !== undefined
      || storedPayload.ClientReference !== undefined
      || storedPayload.clientReference !== undefined
    );
    const callback = isCallbackPayload ? normalizeHubtel(storedPayload) : null;
    const callbackAmountMatches = callback?.amountGhs !== undefined
      && hubtelWalletAmountMatches(callback.amountGhs, Number(order.amount), Number(order.gross_amount));
    if (callback?.state === 'success' && callbackAmountMatches) {
      paymentConfirmed = true;
    } else if (callback?.state === 'failed' && (callback.reference || callback.orderId)) {
      const message = 'Hubtel payment was not approved. The airtime order was recorded as failed and was not dispatched.';
      await markPaymentFailed(admin, order, message, storedPayload);
      return json(responseFor({ ...order, payment_status: 'failed', airtime_status: 'failed', failure_reason: message }, 'failed', message));
    } else if (hubtelPaymentsVerifyConfigured()) {
      const verified = await verifyHubtelCollection(reference);
      if (verified?.state === 'success') {
        if (verified.amountGhs === undefined
          || !hubtelWalletAmountMatches(verified.amountGhs, Number(order.amount), Number(order.gross_amount))) {
          return json(responseFor(order, 'pending_payment', 'Hubtel returned an amount that does not match this order.'));
        }
        paymentConfirmed = true;
        await admin.from('airtime_orders').update({
          provider_response: { ...storedPayload, paymentVerification: verified.payload, lastPaymentCheckAt: new Date().toISOString() },
          provider_reference: order.provider_reference || verified.orderId || null,
          updated_at: new Date().toISOString(),
        }).eq('id', order.id);
      } else if (verified?.state === 'failed') {
        const message = 'Hubtel payment was not approved. The airtime order was recorded as failed and was not dispatched.';
        await markPaymentFailed(admin, order, message, verified.payload);
        return json(responseFor({ ...order, payment_status: 'failed', airtime_status: 'failed', failure_reason: message }, 'failed', message));
      }
    }

    if (!paymentConfirmed) {
      return json(responseFor(order, 'pending_payment', 'Payment is not confirmed yet. Please complete Skaipay and try again.'));
    }

    const { data: claimed, error: claimError } = await admin.rpc('claim_public_airtime_order', { p_order_id: order.id });
    if (claimError) throw claimError;
    if (!claimed) {
      const fresh = await loadOrder(admin, reference);
      return json(responseFor(fresh || order, fresh?.airtime_status === 'delivered' ? 'delivered' : String(fresh?.airtime_status || 'processing')));
    }

    const dispatch = await dispatchAirtimeTopup({
      phone: String(order.recipient_phone),
      network: String(order.network) as 'mtn' | 'telecel' | 'at',
      amount: Number(order.amount),
      reference,
    });
    const providerResponse = dispatch.providerResponse || {};
    const providerReference = dispatch.providerReference || null;

    if (dispatch.success && dispatch.status === 'delivered') {
      const { error } = await admin.rpc('fulfil_airtime_order', {
        p_order_id: order.id,
        p_airtime_status: 'delivered',
        p_provider_reference: providerReference,
        p_provider_response: providerResponse,
        p_failure_reason: null,
      });
      if (error) throw error;
      return json(responseFor({ ...order, airtime_status: 'delivered', payment_status: 'paid' }, 'delivered', `Airtime delivered to ${order.recipient_phone}.`));
    }

    if (dispatch.status === 'pending_provider') {
      await admin.from('airtime_orders').update({
        payment_status: 'paid',
        airtime_status: 'pending_provider',
        provider_reference: providerReference,
        provider_response: providerResponse,
        failure_reason: dispatch.failureReason || null,
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);
      return json(responseFor({ ...order, payment_status: 'paid', airtime_status: 'pending_provider' }, 'processing', 'Payment confirmed. Hubtel is processing the airtime delivery.'));
    }

    // Payment succeeded, but the Commission Services request was rejected. Do
    // not retry blindly: the order is visible as failed and can be reconciled
    // or refunded by support without risking a duplicate top-up.
    const failureReason = dispatch.failureReason || 'Hubtel did not accept the airtime delivery request.';
    await admin.from('airtime_orders').update({
      payment_status: 'paid',
      airtime_status: 'failed',
      provider_reference: providerReference,
      provider_response: providerResponse,
      failure_reason: failureReason,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    return json(responseFor({ ...order, payment_status: 'paid', airtime_status: 'failed', failure_reason: failureReason }, 'failed', `Payment was received, but airtime delivery failed: ${failureReason}`));
  } catch (error) {
    console.error('[verify-public-airtime-payment] failed:', { reference, error: error instanceof Error ? error.message : String(error) });
    return json({ success: false, retryable: true, error: 'Airtime payment is still being reconciled. Please check Track Order again.' }, 503);
  }
});
