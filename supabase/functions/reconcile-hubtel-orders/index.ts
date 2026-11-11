import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { fetchHubtelCommissionStatus } from '../_shared/hubtelCommissionStatus.ts';
import {
  settleHubtelAirtimeOrder,
  settleHubtelUtilityOrder,
} from '../_shared/hubtelSettlement.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';
import { fulfilStoreOrder } from '../_shared/storeOrderFulfillment.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from '../_shared/hubtelPayments.ts';
import { hubtelWalletAmountMatches, normalizeHubtel } from '../_shared/paymentGateway.ts';

/**
 * Sweeps the Hubtel orders whose callback never arrived.
 *
 * A Hubtel order is placed with a callback URL, and Hubtel calls it with the
 * final state. Hubtel does retry, but a callback can be lost for good - a
 * webhook that answers 5xx while it is being redeployed is the usual cause.
 * An order that is never settled is the worst outcome in the whole flow: the
 * customer has no airtime, data or bill and the agent's wallet is still
 * debited with nothing to show for it.
 *
 * This function is the answer to that. Anything still pending more than five
 * minutes after it was created is re-read from Hubtel's Status Check API - the
 * same endpoint the callbacks verify against, correlating on our client
 * reference - and settled if Hubtel has since closed it.
 *
 * Deliberately absent: a timeout that marks an old order failed. A status we
 * could not read is not a decline, and refunding one would give the product
 * away free if Hubtel later reports it delivered. Orders older than
 * MAX_POLL_AGE_HOURS therefore stop being polled and stay pending for an
 * operator to look at, rather than being resolved by guesswork.
 *
 * This is an internal job, so it is not gated on an agent session: it is
 * scheduled by pg_cron and authorised by a shared secret header. It refuses
 * every request when that secret is not configured, so a half-finished setup
 * fails closed instead of exposing an endpoint that can be made to hammer
 * Hubtel's API.
 */

/** Hubtel's final callbacks land within seconds; five minutes means it was lost. */
const CALLBACK_GRACE_MINUTES = 5;

/** Stop polling after this. The row is left pending for an operator, not failed. */
const MAX_POLL_AGE_HOURS = 24;

/** Hubtel's status endpoint answers one order per call, so the batch stays small. */
const MAX_ORDERS_PER_SWEEP = 25;

function sameSecret(provided: string, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('HUBTEL_RECONCILE_SECRET')?.trim();
  if (!expectedSecret) {
    console.error('reconcile-hubtel-orders refused: HUBTEL_RECONCILE_SECRET is not set.');
    return json({ error: 'Reconciliation is not configured.' }, 503);
  }
  if (!sameSecret(request.headers.get('x-reconcile-secret')?.trim() ?? '', expectedSecret)) {
    return json({ error: 'Not authorized.' }, 401);
  }

  try {
    const admin = adminClient();
    const now = Date.now();
    const graceCutoff = new Date(now - CALLBACK_GRACE_MINUTES * 60_000).toISOString();
    const ageFloor = new Date(now - MAX_POLL_AGE_HOURS * 3_600_000).toISOString();

    const airtime = await sweepAirtimeOrders(admin, graceCutoff, ageFloor);
    const walletTopups = await sweepWalletTopups(admin, graceCutoff, ageFloor);
    const publicAirtime = await sweepPublicAirtimeOrders(admin, graceCutoff, ageFloor);
    const utility = await sweepUtilityOrders(admin, graceCutoff, ageFloor);
    const publicData = await sweepPublicDataOrders(admin, graceCutoff, ageFloor);
    const publicStore = await sweepPublicStoreOrders(admin, graceCutoff, ageFloor);
    const changed = airtime.changed + walletTopups.changed + publicAirtime.changed + utility.changed + publicData.changed + publicStore.changed;
    const unreadable = [airtime, walletTopups, publicAirtime, utility, publicData, publicStore].filter((result) => result.failed).length;

    // Reconciliation is not a row write of its own, so record it explicitly.
    // Auditing must never break the sweep, and a Supabase query builder is
    // PromiseLike rather than a Promise (so it has no .catch), hence try/catch.
    if (changed > 0) {
      try {
        await admin.rpc('log_activity', {
          p_summary: `Reconciled ${changed} Hubtel order${changed === 1 ? '' : 's'} that no callback settled`,
          p_meta: { airtime, walletTopups, publicAirtime, utility, publicData, publicStore },
          p_actor_user_id: null,
        });
      } catch (logError) {
        console.error('Hubtel reconcile activity log failed:', logError);
      }
    }

    // A run that could not read its own queue must not report success: `changed:
    // 0` every minute is exactly what a working sweep looks like, so a broken
    // one has to be visibly different from the outside, not only in the logs.
    if (unreadable > 0) {
      return json({ success: false, changed, unreadable, airtime, walletTopups, publicAirtime, utility, publicData, publicStore }, 500);
    }

    return json({ success: true, changed, airtime, walletTopups, publicAirtime, utility, publicData, publicStore });
  } catch (error) {
    console.error('reconcile-hubtel-orders failed:', error);
    return json({ error: 'Reconciliation failed.' }, 500);
  }
});

interface SweepResult {
  checked: number;
  changed: number;
  /** The queue itself could not be read, so this table was not swept at all. */
  failed: boolean;
}

/** Hubtel wallet top-ups, including callbacks that were never delivered. */
async function sweepWalletTopups(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: topups, error } = await admin
    .from('wallet_topups')
    .select('id, payment_reference, provider_order_id, amount, gross_amount, fee_amount, provider_response, status, created_at')
    .eq('provider', 'hubtel')
    .eq('status', 'pending_payment')
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Wallet top-up sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const topup of topups ?? []) {
    const reference = String(topup.payment_reference || '').trim();
    if (!reference) continue;

    try {
      const stored = topup.provider_response && typeof topup.provider_response === 'object'
        ? topup.provider_response as Record<string, unknown>
        : {};
      const callback = normalizeHubtel(stored);
      let state = callback.state;
      let amountGhs = callback.amountGhs;
      let payload: Record<string, unknown> = stored;

      // A persisted successful callback is sufficient because hubtel-webhook
      // already authenticated the callback token/source and bound its
      // ClientReference to this row. The status API is only the recovery path
      // for a callback that never arrived.
      if (state === 'pending' || !amountGhs) {
        const verified = hubtelPaymentsVerifyConfigured()
          ? await verifyHubtelCollection(reference)
          : null;
        if (!verified) continue;
        state = verified.state;
        amountGhs = verified.amountGhs;
        payload = { ...stored, reconciliation: verified.payload };
      }

      if (state === 'pending') continue;

      if (state === 'failed') {
        const { error: failedError } = await admin.from('wallet_topups')
          .update({ status: 'failed' })
          .eq('id', topup.id)
          .eq('status', 'pending_payment');
        if (failedError) throw failedError;
        changed += 1;
        continue;
      }

      if (state !== 'success' || amountGhs === undefined
        || !hubtelWalletAmountMatches(amountGhs, Number(topup.amount), Number(topup.gross_amount))) {
        continue;
      }

      const { error: saveError } = await admin.from('wallet_topups').update({
        provider_response: payload,
        gross_amount: Math.round(amountGhs * 100) / 100,
        fee_amount: Math.round((amountGhs - Number(topup.amount)) * 100) / 100,
      }).eq('id', topup.id).eq('status', 'pending_payment');
      if (saveError) throw saveError;

      const { error: fulfilError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
      if (fulfilError) throw fulfilError;
      changed += 1;
    } catch (settleError) {
      console.error('Wallet top-up sweep settlement failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (topups ?? []).length, changed, failed: false };
}

/** Airtime orders, settled against `airtime_orders`. */
async function sweepAirtimeOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('airtime_orders')
    .select('id, agent_id, payment_reference, amount, wallet_charge_amount, provider_reference, payment_method')
    .in('airtime_status', ['pending', 'pending_provider', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Airtime order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    // Guest Hubtel checkout rows are reconciled separately. The Commission
    // Services status endpoint is for the delivery request, not the checkout
    // payment, so querying it before payment confirmation is unsafe.
    if (!order.agent_id && String(order.payment_method) === 'hubtel') continue;
    const reference = String(order.payment_reference);

    const verified = await fetchHubtelCommissionStatus(reference).catch((statusError) => {
      console.error('Airtime order status check failed:', { reference, error: String(statusError) });
      return null;
    });
    if (!verified || verified.state === 'pending') continue;

    try {
      await settleHubtelAirtimeOrder(admin, {
        id: String(order.id),
        agent_id: order.agent_id ? String(order.agent_id) : null,
        payment_reference: reference,
        amount: Number(order.amount),
        wallet_charge_amount: Number(order.wallet_charge_amount ?? order.amount),
        provider_reference: order.provider_reference ? String(order.provider_reference) : null,
      }, {
        state: verified.state,
        payload: verified.payload,
        providerReference: verified.orderId ?? null,
      });
      changed += 1;
    } catch (settleError) {
      console.error('Airtime order sweep settle failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/** Reconciles guest Hubtel checkout confirmation and guest airtime delivery. */
async function sweepPublicAirtimeOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('airtime_orders')
    .select('id, payment_reference, amount, gross_amount, payment_status, airtime_status, provider_reference, created_at')
    .is('agent_id', null)
    .eq('payment_method', 'hubtel')
    .in('payment_status', ['pending_payment', 'paid'])
    .in('airtime_status', ['pending', 'processing', 'pending_provider'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Public airtime order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  if (!baseUrl) return { checked: (orders ?? []).length, changed: 0, failed: true };

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.payment_reference || '').trim();
    if (!reference) continue;
    try {
      if (String(order.airtime_status) === 'pending_provider') {
        const delivery = await fetchHubtelCommissionStatus(reference).catch(() => null);
        if (!delivery || delivery.state === 'pending') continue;
        await settleHubtelAirtimeOrder(admin, {
          id: String(order.id),
          agent_id: null,
          payment_reference: reference,
          amount: Number(order.amount),
          wallet_charge_amount: Number(order.amount),
          provider_reference: order.provider_reference ? String(order.provider_reference) : null,
        }, {
          state: delivery.state,
          payload: delivery.payload,
          providerReference: delivery.orderId ?? null,
        });
        changed += 1;
        continue;
      }

      // This calls the same payment-gated dispatch path as the Hubtel callback
      // and the browser return page. It is safe to retry because the claim RPC
      // permits only a still-pending guest row.
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-airtime-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 503) {
        console.error('Public airtime payment sweep failed:', { reference, httpStatus: response.status, payload });
        continue;
      }
      if (['delivered', 'failed', 'processing'].includes(String(payload?.status || '').toLowerCase())) changed += 1;
    } catch (sweepError) {
      console.error('Public airtime order sweep request failed:', { reference, error: String(sweepError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/**
 * Utility bill orders, settled against `utility_orders`.
 *
 * Electricity settles like any other utility: Hubtel tops the meter up
 * asynchronously and confirms only the payment, not the token, which reaches
 * the customer by SMS. A successful status therefore closes the order rather
 * than leaving it `processing`, so the wallet debit is not stranded.
 */
async function sweepUtilityOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('utility_orders')
    .select('id, agent_id, payment_reference, gross_amount, wallet_charge_amount, bill_category, provider_reference, status')
    .in('status', ['paid', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Utility order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.payment_reference);

    const verified = await fetchHubtelCommissionStatus(reference).catch((statusError) => {
      console.error('Utility order status check failed:', { reference, error: String(statusError) });
      return null;
    });
    if (!verified || verified.state === 'pending') continue;

    try {
      const outcome = await settleHubtelUtilityOrder(admin, {
        id: String(order.id),
        agent_id: order.agent_id ? String(order.agent_id) : null,
        payment_reference: reference,
        gross_amount: Number(order.gross_amount),
        wallet_charge_amount: Number(order.wallet_charge_amount ?? order.gross_amount),
        bill_category: String(order.bill_category),
        provider_reference: order.provider_reference ? String(order.provider_reference) : null,
      }, {
        state: verified.state,
        payload: verified.payload,
        providerReference: verified.orderId ?? null,
      });
      if (outcome !== 'processing') changed += 1;
    } catch (settleError) {
      console.error('Utility order sweep settle failed:', { reference, error: String(settleError) });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/** Public Hubtel checkouts must not depend on the customer's return browser. */
async function sweepPublicDataOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('public_data_orders')
    .select('id, payment_reference, status, provider_name, provider_reference, network_type, volume_mb, provider_response')
    .eq('payment_provider', 'hubtel')
    .in('status', ['pending_payment', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Public data order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  if (!baseUrl) {
    console.error('Public data order sweep skipped: SUPABASE_URL is not configured.');
    return { checked: (orders ?? []).length, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const reference = String(order.payment_reference || '').trim();
    if (!reference) continue;
    try {
      if (String(order.status) === 'processing') {
        const stored = order.provider_response && typeof order.provider_response === 'object'
          ? order.provider_response as Record<string, unknown>
          : {};
        const provider = String(order.provider_name || stored.provider || activeDataProvider(order.network_type, Number(order.volume_mb)));
        const providerReference = String(order.provider_reference || stored.providerReference || stored.providerOrderId || '').trim();
        if (!providerReference) continue;

        const live = await fetchDataOrderStatus(
          provider as 'grandtech' | 'swift',
          providerReference,
          String(stored.providerOrderId || ''),
        ).catch((statusError) => {
          console.error('Public data provider status check failed:', { reference, error: String(statusError) });
          return null;
        });
        if (!live || live.state === 'processing') continue;

        const nextStatus = live.state === 'successful' ? 'successful' : 'failed';
        const { error: statusError } = await admin.rpc('mark_public_data_order', {
          p_order_id: order.id,
          p_status: nextStatus,
          p_provider_amount: null,
          p_provider_reference: providerReference,
          p_provider_response: {
            ...stored,
            provider: provider,
            lastProviderStatus: live.status,
            lastProviderPayload: live.payload || {},
            checkedAt: new Date().toISOString(),
          },
        });
        if (statusError) throw statusError;
        changed += 1;
        continue;
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-data-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        console.error('Public data order sweep settlement failed:', {
          reference,
          httpStatus: response.status,
          response: payload,
        });
        continue;
      }
      if (payload?.success || ['processing', 'successful', 'failed'].includes(String(payload?.status || '').toLowerCase())) {
        changed += 1;
      }
    } catch (sweepError) {
      console.error('Public data order sweep request failed:', {
        reference,
        error: sweepError instanceof Error ? sweepError.message : String(sweepError),
      });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}

/** Reconciles customer purchases made through public agent store links. */
async function sweepPublicStoreOrders(
  admin: ReturnType<typeof adminClient>,
  graceCutoff: string,
  ageFloor: string,
): Promise<SweepResult> {
  const { data: orders, error } = await admin
    .from('store_orders')
    .select('id, reference, payment_status, fulfilment_status, created_at, meta')
    .eq('product_type', 'data_bundle')
    .contains('meta', { source: 'public_storefront' })
    .in('payment_status', ['pending', 'paid'])
    .in('fulfilment_status', ['pending', 'processing'])
    .lt('created_at', graceCutoff)
    .gt('created_at', ageFloor)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);

  if (error) {
    console.error('Public store order sweep read failed:', error);
    return { checked: 0, changed: 0, failed: true };
  }

  let changed = 0;
  for (const order of orders ?? []) {
    try {
      const result = await fulfilStoreOrder(String(order.reference));
      if (['successful', 'failed'].includes(result.fulfilmentStatus)) changed += 1;
    } catch (sweepError) {
      console.error('Public store order sweep failed:', {
        reference: order.reference,
        error: sweepError instanceof Error ? sweepError.message : String(sweepError),
      });
    }
  }

  return { checked: (orders ?? []).length, changed, failed: false };
}
