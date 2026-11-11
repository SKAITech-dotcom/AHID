import { hubtelWalletAmountMatches } from '../_shared/paymentGateway.ts';
import { adminClient, json } from '../_shared/supabase.ts';

/**
 * Hubtel checkout callback — the Hubtel half of the wallet-funding webhook, the
 * Paystack half being `paystack-webhook`. Both credit the wallet through the one
 * idempotent `fulfil_wallet_topup`, so either gateway settles the same.
 *
 * Hubtel does not sign production callbacks. New checkouts carry an
 * application callback token; legacy callbacks may pass only from Hubtel's
 * documented Online Checkout callback address. The reference and exact amount
 * must match the durable top-up before the wallet is credited.
 */

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // Fall through to form-encoded handling below.
  }
  const form = new URLSearchParams(raw);
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) body[key] = value;
  return body;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const callbackSecret = Deno.env.get('HUBTEL_WALLET_CALLBACK_SECRET')?.trim();
    if (callbackSecret) {
      const suppliedToken = new URL(request.url).searchParams.get('token') || '';
      const sourceIp = request.headers.get('cf-connecting-ip')?.trim()
        || request.headers.get('x-real-ip')?.trim()
        || '';
      const isDocumentedHubtelSource = sourceIp === '108.129.40.25';
      if (suppliedToken !== callbackSecret && !isDocumentedHubtelSource) {
        return json({ error: 'Invalid callback token.' }, 401);
      }
    }

    const payload = await readJson(request);
    // Hubtel's current Online Checkout callback puts transaction fields inside
    // PascalCase `Data`. Keep root-level and camelCase fallbacks for older or
    // replayed payloads, but prefer the documented callback shape.
    const callbackData = payload.Data && typeof payload.Data === 'object'
      ? payload.Data as Record<string, unknown>
      : payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : {};
    const responseCode = String(
      payload.ResponseCode ?? payload.responseCode ?? callbackData.ResponseCode ?? callbackData.responseCode ?? ''
    ).trim();
    const status = String(payload.Status ?? payload.status ?? callbackData.Status ?? callbackData.status ?? '').trim().toUpperCase();
    const reference = String(payload.ClientReference ?? payload.clientReference ?? callbackData.ClientReference ?? callbackData.clientReference ?? '').trim();
    const orderId = String(
      payload.CheckoutId ?? payload.checkoutId ?? payload.SalesInvoiceId
      ?? payload.salesInvoiceId ?? payload.OrderId ?? payload.orderId
      ?? callbackData.CheckoutId ?? callbackData.checkoutId ?? callbackData.SalesInvoiceId
      ?? callbackData.salesInvoiceId ?? callbackData.OrderId ?? callbackData.orderId ?? ''
    ).trim();
    const amount = Number(
      payload.AmountCharged ?? payload.amountCharged
      ?? callbackData.AmountCharged ?? callbackData.amountCharged
      ?? payload.Amount ?? payload.amount ?? callbackData.Amount ?? callbackData.amount,
    );
    const charges = Number(
      payload.Charges ?? payload.charges ?? callbackData.Charges ?? callbackData.charges,
    );
    const isSuccessfulCallback = responseCode === '0000' && status === 'SUCCESS';
    const isFailedCallback = responseCode === '2001' || ['FAILED', 'DECLINED', 'CANCELLED', 'CANCELED'].includes(status);

    console.log('--- INCOMING HUBTEL CALLBACK ---', JSON.stringify(payload, null, 2));
    console.log('[Hubtel wallet callback]', JSON.stringify({
      responseCode,
      status,
      reference,
      amount,
      charges,
      checkoutId: orderId,
    }, null, 2));

    // Guest/non-agent data checkouts use the same authenticated Hubtel callback
    // endpoint, but they must never touch wallet_topups. The browser return
    // flow consumes this persisted callback through verify-public-data-payment.
    if (/^(?:PUB[0-9a-f]{29}|PUB-GUEST-[0-9a-f-]{36})$/i.test(reference)) {
      const admin = adminClient();
      const { data: publicOrder, error: publicOrderError } = await admin
        .from('public_data_orders')
        .select('id, status, sale_amount, payment_gross_amount, payment_provider')
        .eq('payment_reference', reference)
        .maybeSingle();
      if (publicOrderError) {
        console.error('[Hubtel guest callback] Order lookup failed', publicOrderError);
        return json({ received: true, settled: false }, 200);
      }
      if (!publicOrder) {
        console.error('[Hubtel guest callback] No matching public data order', { reference, orderId });
        return json({ received: true, settled: false }, 200);
      }
      const publicUpdate: Record<string, unknown> = { provider_response: payload };
      if (isFailedCallback && ['pending_payment', 'processing'].includes(String(publicOrder.status))) {
        publicUpdate.status = 'failed';
        publicUpdate.completed_at = new Date().toISOString();
      }
      const { error: publicSaveError } = await admin
        .from('public_data_orders')
        .update(publicUpdate)
        .eq('id', publicOrder.id);
      if (publicSaveError) console.error('[Hubtel guest callback] Callback persistence failed', publicSaveError);

      // Do not depend on the browser return page to create the provider order.
      // Hubtel has already authenticated this callback and the amount is bound
      // to the durable order, so settle/dispatch through the same idempotent
      // verification path used by the customer return flow.
      const callbackAmountMatches = hubtelWalletAmountMatches(
        amount,
        Number(publicOrder.sale_amount),
        Number(publicOrder.payment_gross_amount),
      );
      if (isSuccessfulCallback && callbackAmountMatches
        && ['pending_payment', 'processing'].includes(String(publicOrder.status))) {
        const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
        if (!baseUrl) {
          console.error('[Hubtel guest callback] SUPABASE_URL is not configured; dispatch deferred', { reference });
        } else {
          try {
            const dispatchResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-data-payment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference }),
            });
            const dispatchPayload = await dispatchResponse.json().catch(() => ({}));
            if (!dispatchResponse.ok || dispatchPayload?.error) {
              console.error('[Hubtel guest callback] Automatic provider dispatch did not complete', {
                reference,
                httpStatus: dispatchResponse.status,
                response: dispatchPayload,
              });
            }
          } catch (dispatchError) {
            console.error('[Hubtel guest callback] Automatic provider dispatch request failed', {
              reference,
              error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
            });
          }
        }
      } else if (isSuccessfulCallback && !callbackAmountMatches) {
        console.error('[Hubtel guest callback] Amount mismatch; provider dispatch deferred', {
          reference,
          callbackAmount: amount,
          expectedSaleAmount: Number(publicOrder.sale_amount),
          expectedGrossAmount: Number(publicOrder.payment_gross_amount),
        });
      }
      return json({ received: true, settled: false }, 200);
    }

    // Guest airtime uses the same authenticated Hubtel Online Checkout callback
    // but must never dispatch before this payment callback is confirmed.
    if (/^PAI[0-9a-f]{29}$/i.test(reference)) {
      const admin = adminClient();
      const { data: airtimeOrder, error: airtimeLookupError } = await admin
        .from('airtime_orders')
        .select('id, payment_reference, amount, gross_amount, payment_status, airtime_status')
        .eq('payment_reference', reference)
        .is('agent_id', null)
        .maybeSingle();
      if (airtimeLookupError) {
        console.error('[Hubtel guest airtime callback] Order lookup failed', airtimeLookupError);
        return json({ received: true, settled: false }, 200);
      }
      if (!airtimeOrder) {
        console.error('[Hubtel guest airtime callback] No matching order', { reference, orderId });
        return json({ received: true, settled: false }, 200);
      }

      const { error: saveError } = await admin.from('airtime_orders').update({
        provider_response: payload,
        provider_reference: orderId || null,
        updated_at: new Date().toISOString(),
      }).eq('id', airtimeOrder.id);
      if (saveError) console.error('[Hubtel guest airtime callback] Callback persistence failed', saveError);

      if (isFailedCallback && ['pending_payment', 'paid'].includes(String(airtimeOrder.payment_status))) {
        await admin.from('airtime_orders').update({
          payment_status: 'failed',
          airtime_status: 'failed',
          failure_reason: 'Skaipay payment was not successful.',
          updated_at: new Date().toISOString(),
        }).eq('id', airtimeOrder.id).in('payment_status', ['pending_payment', 'paid']);
        return json({ received: true, settled: false }, 200);
      }

      const amountMatches = hubtelWalletAmountMatches(
        amount,
        Number(airtimeOrder.amount),
        Number(airtimeOrder.gross_amount),
      );
      if (isSuccessfulCallback && amountMatches
        && String(airtimeOrder.airtime_status) === 'pending'
        && String(airtimeOrder.payment_status) === 'pending_payment') {
        const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
        if (baseUrl) {
          try {
            const dispatchResponse = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-airtime-payment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference }),
            });
            const dispatchPayload = await dispatchResponse.json().catch(() => ({}));
            if (!dispatchResponse.ok || dispatchPayload?.error) {
              console.error('[Hubtel guest airtime callback] Automatic dispatch did not complete', {
                reference,
                httpStatus: dispatchResponse.status,
                response: dispatchPayload,
              });
            }
          } catch (dispatchError) {
            console.error('[Hubtel guest airtime callback] Automatic dispatch request failed', dispatchError);
          }
        }
      } else if (isSuccessfulCallback && !amountMatches) {
        console.error('[Hubtel guest airtime callback] Amount mismatch; dispatch deferred', {
          reference,
          callbackAmount: amount,
          expectedAmount: Number(airtimeOrder.amount),
          expectedGrossAmount: Number(airtimeOrder.gross_amount),
        });
      }
      return json({ received: true, settled: false }, 200);
    }

    // Public agent-store purchases can use Skaipay/Hubtel for low-value
    // bundles. Persist the authenticated callback on the store order; the
    // browser return (or a later retry) verifies the amount before dispatching.
    if (/^STR(?:[0-9a-f]{29}|-[0-9a-f-]{36})$/i.test(reference)) {
      const admin = adminClient();
      const { data: storeOrder, error: storeOrderError } = await admin
        .from('store_orders')
        .select('id, sale_amount, payment_status, fulfilment_status')
        .eq('reference', reference)
        .maybeSingle();
      if (storeOrderError) {
        console.error('[Hubtel store callback] Order lookup failed', storeOrderError);
        return json({ received: true, settled: false }, 200);
      }
      if (!storeOrder) {
        console.error('[Hubtel store callback] No matching store order', { reference, orderId });
        return json({ received: true, settled: false }, 200);
      }

      const storeUpdate: Record<string, unknown> = {
        provider_response: payload,
        payment_provider: 'hubtel',
        updated_at: new Date().toISOString(),
      };
      if (Number.isFinite(amount) && amount >= Number(storeOrder.sale_amount || 0)) {
        storeUpdate.payment_gross_amount = Math.round(amount * 100) / 100;
        storeUpdate.payment_fee_amount = Math.round((amount - Number(storeOrder.sale_amount || 0)) * 100) / 100;
        storeUpdate.payment_fee = storeUpdate.payment_fee_amount;
      }
      if (isFailedCallback && ['pending', 'pending_payment', 'processing'].includes(String(storeOrder.fulfilment_status))) {
        storeUpdate.payment_status = 'failed';
        storeUpdate.fulfilment_status = 'failed';
        storeUpdate.failure_reason = 'Skaipay payment was not successful.';
        storeUpdate.completed_at = new Date().toISOString();
      }
      const { error: storeSaveError } = await admin.from('store_orders').update(storeUpdate).eq('id', storeOrder.id);
      if (storeSaveError) console.error('[Hubtel store callback] Callback persistence failed', storeSaveError);
      return json({ received: true, settled: false }, 200);
    }

    if (!reference && !orderId) {
      console.error('[Hubtel wallet callback] Missing ClientReference and CheckoutId', payload);
      return json({ received: true, settled: false });
    }

    const admin = adminClient();
    const match = reference
      ? await admin.from('wallet_topups').select('*').eq('payment_reference', reference).maybeSingle()
      : { data: null, error: null };
    if (match.error) {
      console.error('[Hubtel wallet callback] Top-up lookup by ClientReference failed', match.error);
      return json({ received: true, settled: false }, 200);
    }
    let topup = match.data;
    if (!topup && orderId) {
      const byOrder = await admin.from('wallet_topups').select('*').eq('provider_order_id', orderId).maybeSingle();
      if (byOrder.error) {
        console.error('[Hubtel wallet callback] Top-up lookup by CheckoutId failed', byOrder.error);
        return json({ received: true, settled: false }, 200);
      }
      topup = byOrder.data;
    }
    if (!topup) {
      console.error('[Hubtel wallet callback] No matching wallet top-up', { reference, orderId });
      return json({ received: true, settled: false });
    }
    if (topup.provider !== 'hubtel' || topup.status === 'paid') return json({ received: true, settled: topup.status === 'paid' });

    const callbackUpdate: Record<string, unknown> = { provider_response: payload };
    if (orderId && !topup.provider_order_id) callbackUpdate.provider_order_id = orderId;
    const { error: callbackSaveError } = await admin
      .from('wallet_topups')
      .update(callbackUpdate)
      .eq('id', topup.id);
    if (callbackSaveError) {
      console.error('[Hubtel wallet callback] Callback persistence failed', callbackSaveError);
      // Hubtel must retry when the callback could not be durably stored.
      return json({ received: false, settled: false, retryable: true }, 503);
    }

    if (isFailedCallback) {
      const { error: failedUpdateError } = await admin.from('wallet_topups')
        .update({ status: 'failed' })
        .eq('id', topup.id)
        .eq('status', 'pending_payment');
      if (failedUpdateError) console.error('[Hubtel wallet callback] Failed-status update failed', failedUpdateError);
      return json({ received: true, settled: false });
    }

    if (!isSuccessfulCallback) return json({ received: true, settled: false });
    if (!hubtelWalletAmountMatches(amount, Number(topup.amount), Number(topup.gross_amount))) {
      console.error('[Hubtel wallet callback] Amount mismatch', {
        reference,
        callbackAmount: amount,
        expectedNetAmount: Number(topup.amount),
        expectedGrossAmount: Number(topup.gross_amount),
      });
      return json({ received: true, settled: false });
    }

    // Store the actual customer-paid amount when Hubtel reports a fee-inclusive
    // callback. The wallet is credited only with the original requested amount.
    if (Number.isFinite(amount) && amount >= Number(topup.amount)) {
      callbackUpdate.gross_amount = Math.round(amount * 100) / 100;
      callbackUpdate.fee_amount = Math.round((amount - Number(topup.amount)) * 100) / 100;
      const { error: amountSaveError } = await admin
        .from('wallet_topups')
        .update(callbackUpdate)
        .eq('id', topup.id);
      if (amountSaveError) {
        console.error('[Hubtel wallet callback] Gross amount persistence failed', amountSaveError);
        return json({ received: false, settled: false, retryable: true }, 503);
      }
    }

    const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (creditError) {
      console.error('[Hubtel wallet callback] Wallet credit RPC failed', creditError);
      // The callback is persisted and `fulfil_wallet_topup` is idempotent, so
      // retrying is safe and prevents a transient database failure from
      // permanently stranding a successful deposit.
      return json({ received: false, settled: false, retryable: true }, 503);
    }
    return json({ received: true, settled: true });
  } catch (error) {
    console.error('[Hubtel wallet callback] Unexpected processing failure', error);
    // Acknowledge the callback so Hubtel does not retry an already-recorded
    // event forever; the persisted payload/log identifies the failed step.
    return json({ received: true, settled: false }, 200);
  }
});
