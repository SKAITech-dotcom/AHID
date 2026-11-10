import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from '../_shared/hubtelPayments.ts';
import { hubtelWalletAmountMatches, normalizeHubtel } from '../_shared/paymentGateway.ts';

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

async function refundPaystack(reference: string) {
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
  if (!secret) return { requested: false, ok: false };
  const response = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: reference }),
  });
  const payload = await response.json().catch(() => ({}));
  return { requested: true, ok: response.ok && payload.status !== false, payload };
}

async function currentOrder(admin: ReturnType<typeof adminClient>, reference: string) {
  const { data, error } = await admin.from('public_data_orders')
    .select('id, payment_reference, public_access_token, short_code, customer_phone, network_type, volume_mb, sale_amount, status, provider_response, provider_name, provider_package_id, provider_reference, payment_provider, payment_gross_amount, created_at')
    .eq('payment_reference', reference)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Verifies a guest Hubtel payment and dispatches the same provider path used by the return flow. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = adminClient();
  let reference = '';
  let paymentProvider = 'paystack';
  try {
    const body = await request.json().catch(() => ({}));
    reference = String(body.reference || '').trim();
    if (!/^(?:PUB[0-9a-f]{29}|PUB-GUEST-[0-9a-f-]{36})$/i.test(reference)) {
      return json({ error: 'A valid payment reference is required.' }, 400);
    }

    const order = await currentOrder(admin, reference);
    if (!order) return json({ error: 'Order not found.' }, 404);
    paymentProvider = String(order.payment_provider || 'paystack').toLowerCase();
    if (['successful', 'failed', 'cancelled'].includes(String(order.status))) {
      return json({ success: order.status === 'successful', status: order.status, order });
    }

    if (paymentProvider === 'hubtel') {
      const callbackPayload = order.provider_response && typeof order.provider_response === 'object'
        ? normalizeHubtel(order.provider_response)
        : null;
      const callbackAmount = callbackPayload?.amountGhs;
      const callbackSuccess = callbackPayload?.state === 'success'
        && callbackAmount !== undefined
        && hubtelWalletAmountMatches(callbackAmount, Number(order.sale_amount), Number(order.payment_gross_amount));
      if (callbackSuccess) {
        // The authenticated Hubtel callback is sufficient. The status endpoint
        // is only a recovery path for a callback that has not arrived yet.
      } else if (callbackPayload?.state === 'failed') {
        return json({ success: false, status: 'failed', message: 'Hubtel payment was not successful.' });
      } else {
        const verified = hubtelPaymentsVerifyConfigured()
          ? await verifyHubtelCollection(reference)
          : null;
        if (!verified || verified.state === 'pending') {
          return json({ success: false, status: 'pending_payment', message: 'Payment is not confirmed yet. Please wait a moment and try again.' });
        }
        if (verified.state === 'failed' || verified.amountGhs === undefined
          || !hubtelWalletAmountMatches(verified.amountGhs, Number(order.sale_amount), Number(order.payment_gross_amount))) {
          return json({ success: false, status: 'pending_payment', message: 'Payment is still being confirmed.' });
        }
      }
    } else {
      const secret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
      if (!secret) return json({ error: 'Payment verification is not configured.' }, 503);
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json().catch(() => ({}));
      const feeRateValue = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
      const feeRate = Number.isFinite(feeRateValue) && feeRateValue >= 0 && feeRateValue < 1 ? feeRateValue : 0.0195;
      const expectedGross = Math.round(roundMoney(Number(order.sale_amount) * (1 + feeRate)) * 100);
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== expectedGross || transaction.data.currency !== 'GHS') {
        return json({ success: false, status: 'pending_payment', message: 'Payment is not confirmed yet. Please wait a moment and try again.' });
      }
    }

    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID')?.trim();
    if (!companyAgentId) throw new Error('Public data provider funding is not configured.');
    const dataPackage = await resolveDataPackage(String(order.network_type), Number(order.volume_mb));
    if (!dataPackage || !Number.isFinite(dataPackage.costGhs) || dataPackage.costGhs <= 0) {
      throw new Error('The selected bundle is no longer available from its provider.');
    }

    // Do this before claiming the row. If the public provider wallet is empty,
    // leave the paid callback retryable instead of moving it into a state that
    // cannot create the provider order.
    const { data: fundingWallet, error: fundingWalletError } = await admin
      .from('wallets')
      .select('balance')
      .eq('id', companyAgentId)
      .maybeSingle();
    if (fundingWalletError) throw fundingWalletError;
    if (!fundingWallet || Number(fundingWallet.balance || 0) < Number(dataPackage.costGhs)) {
      console.error('Guest data dispatch waiting for public provider funding', {
        reference,
        companyAgentId,
        provider: dataPackage.provider,
        providerCost: Number(dataPackage.costGhs),
        walletBalance: Number(fundingWallet?.balance || 0),
      });
      return json({
        success: false,
        status: 'pending_payment',
        retryable: true,
        message: 'Payment received. Your bundle is waiting for provider funding and will be retried automatically.',
      });
    }

    const { data: claimed, error: claimError } = await admin.rpc('claim_public_data_order', { p_order_id: order.id });
    if (claimError) throw claimError;
    if (!claimed) {
      const fresh = await currentOrder(admin, reference);
      return json({ success: fresh?.status === 'successful', status: fresh?.status || 'processing', order: fresh });
    }

    const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
    const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: companyAgentId,
      p_reference: providerReference,
      p_network_type: order.network_type,
      p_phone: order.customer_phone,
      p_volume_mb: order.volume_mb,
      p_amount: roundMoney(dataPackage.costGhs),
    });
    if (reserveError) throw reserveError;

    const reservationPayload = {
      ...(order.provider_response && typeof order.provider_response === 'object' ? order.provider_response : {}),
      provider: dataPackage.provider,
      providerReference,
      providerOrderId: null,
      reservedAt: new Date().toISOString(),
    };
    const { error: reservationLinkError } = await admin.from('public_data_orders').update({
      provider_name: dataPackage.provider,
      provider_package_id: dataPackage.id,
      provider_reference: providerReference,
      provider_response: reservationPayload,
    }).eq('id', order.id).eq('status', 'processing');
    if (reservationLinkError) throw reservationLinkError;

    let dispatch;
    try {
      dispatch = await buyDataPackage(dataPackage, String(order.network_type), String(order.customer_phone || ''));
    } catch (error) {
      dispatch = {
        success: false,
        provider: dataPackage.provider,
        status: 'failed',
        payload: { error: error instanceof Error ? error.message : 'Provider request failed.' },
        failureReason: error instanceof Error ? error.message : 'Provider request failed.',
      };
    }

    const providerPayload = {
      ...(dispatch.payload || {}),
      provider: dataPackage.provider,
      providerOrderId: dispatch.orderId || null,
      providerReference: dispatch.providerReference || providerReference,
    };
    const { error: completeError } = await admin.rpc('complete_agent_data_order', {
      p_order_id: providerOrderId,
      p_success: dispatch.success,
      p_provider_response: providerPayload,
    });
    if (completeError) throw completeError;

    if (dispatch.success) {
      const { error: publicMarkError } = await admin.rpc('mark_public_data_order', {
        p_order_id: order.id,
        p_status: 'processing',
        p_provider_amount: roundMoney(dataPackage.costGhs),
        p_provider_reference: providerReference,
        p_provider_response: providerPayload,
      });
      if (publicMarkError) throw publicMarkError;
      await admin.from('public_data_orders').update({ provider_name: dataPackage.provider, provider_package_id: dataPackage.id }).eq('id', order.id);
      return json({ success: true, status: 'processing', orderReference: reference, orderCode: order.short_code });
    }

    const refund = paymentProvider === 'paystack'
      ? await refundPaystack(reference)
      : { requested: false, ok: false };
    const { error: failedMarkError } = await admin.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: 'failed',
      p_provider_amount: roundMoney(dataPackage.costGhs),
      p_provider_reference: providerReference,
      p_provider_response: { ...providerPayload, refundRequested: refund.requested, refundSucceeded: refund.ok },
    });
    if (failedMarkError) throw failedMarkError;
    const paymentUpdate: Record<string, unknown> = {
      provider_name: dataPackage.provider,
      provider_package_id: dataPackage.id,
    };
    if (paymentProvider === 'paystack') paymentUpdate.paystack_refund_status = refund.ok ? 'initiated' : 'failed';
    await admin.from('public_data_orders').update(paymentUpdate).eq('id', order.id);
    return json({
      success: false,
      status: 'failed',
      refunded: refund.ok,
      message: refund.ok
        ? 'The bundle could not be delivered. Your payment has been refunded.'
        : paymentProvider === 'hubtel'
          ? 'The bundle could not be delivered. Please contact support for the Hubtel payment refund.'
          : 'The bundle could not be delivered. Refund processing needs administrator attention.',
    });
  } catch (error) {
    const message = errorMessage(error, 'Guest checkout failed.');
    console.error('verify-public-data-payment failed:', { reference, error: message });
    if (reference) {
      const { data: current } = await admin.from('public_data_orders')
        .select('status, provider_reference, provider_response')
        .eq('payment_reference', reference)
        .maybeSingle();
      const existingResponse = current?.provider_response && typeof current.provider_response === 'object'
        ? current.provider_response as Record<string, unknown>
        : {};
      const errorUpdate: Record<string, unknown> = {
        provider_response: {
          ...existingResponse,
          lastError: message,
          lastErrorAt: new Date().toISOString(),
        },
      };
      // Keep a paid order retryable when no provider reservation was linked.
      // Once a reservation exists, keep it processing so status reconciliation
      // can finish the already-created provider order instead of duplicating it.
      if (current?.status === 'processing' && !current.provider_reference) {
        errorUpdate.status = 'pending_payment';
        errorUpdate.completed_at = null;
      }
      await admin.from('public_data_orders').update(errorUpdate).eq('payment_reference', reference);
      if (paymentProvider === 'paystack') {
        const refund = await refundPaystack(reference).catch(() => ({ requested: false, ok: false }));
        if (refund.ok) await admin.from('public_data_orders').update({ paystack_refund_status: 'initiated' }).eq('payment_reference', reference);
      }
    }
    return json({ error: message, retryable: true }, 503);
  }
});
