import { adminClient } from './supabase.ts';
import { buyDataPackage, resolveDataPackage, type DataBuyResult } from './dataProvider.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from './hubtelPayments.ts';
import { hubtelWalletAmountMatches, normalizeHubtel } from './paymentGateway.ts';
import { refundWallet } from './wallet.ts';
import { volumeForBundleId } from './dataCatalog.ts';

const round2 = (value: number) => Math.round(value * 100) / 100;

async function creditStoreProfit(admin: ReturnType<typeof adminClient>, orderId: string) {
  const { error } = await admin.rpc('credit_store_order_profit', { p_order_id: orderId });
  if (error) console.error('Store profit credit failed:', error);
}

export interface StoreOrderFulfillmentResult {
  success: boolean;
  orderReference: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  profitMargin: number;
  message: string;
  recipient?: string;
  bundleTitle?: string;
}

/**
 * Idempotently verifies payment with the selected gateway, fulfills bundle dispatch,
 * and records the agent's store margin. Public storefront payments fund the
 * fulfilment directly; the margin is credited to the commission wallet only
 * after successful delivery.
 */
export async function fulfilStoreOrder(reference: string): Promise<StoreOrderFulfillmentResult> {
  const admin = adminClient();

  // 1. Fetch store order
  const { data: order, error: orderError } = await admin
    .from('store_orders')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error('Store order not found.');
  }

  const paymentProvider = String(order.payment_provider || 'paystack').trim().toLowerCase();

  // Idempotency: once payment has been settled and fulfilment has reached a
  // terminal/processing state, do not dispatch or refund the same payment a
  // second time. This must not depend on wallet_debited because public
  // storefront orders intentionally do not debit the owner's wallet.
  if (order.payment_status === 'paid' && order.fulfilment_status !== 'pending') {
    if (order.fulfilment_status === 'successful') await creditStoreProfit(admin, order.id);
    return {
      success: order.fulfilment_status !== 'failed',
      orderReference: order.reference,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      profitMargin: Number(order.agent_earning || 0),
      message: order.fulfilment_status === 'failed'
        ? (order.failure_reason || 'Order delivery could not be completed.')
        : `Order fulfilled. Bundle delivered to ${order.recipient}.`,
      recipient: order.recipient,
      bundleTitle: order.product_label,
    };
  }

  // 2. Verify payment status with the gateway saved on this durable order.
  // Hubtel callbacks are persisted by hubtel-webhook; its status endpoint is a
  // recovery path when the browser returns before the callback arrives.
  let paymentConfirmed = false;
  let paymentFailureReason = 'Payment verification failed.';
  let secret: string | undefined;
  if (paymentProvider === 'hubtel') {
    const callbackPayload = order.provider_response && typeof order.provider_response === 'object'
      ? normalizeHubtel(order.provider_response)
      : null;
    const callbackAmount = callbackPayload?.amountGhs;
    const callbackSuccess = callbackPayload?.state === 'success'
      && callbackAmount !== undefined
      && hubtelWalletAmountMatches(callbackAmount, Number(order.sale_amount), Number(order.payment_gross_amount));
    if (callbackSuccess) {
      paymentConfirmed = true;
    } else if (callbackPayload?.state === 'failed') {
      paymentFailureReason = callbackPayload.message || 'Skaipay payment was not successful.';
    } else {
      const verified = hubtelPaymentsVerifyConfigured()
        ? await verifyHubtelCollection(reference)
        : null;
      const verifiedAmountMatches = verified?.state === 'success'
        && verified.amountGhs !== undefined
        && hubtelWalletAmountMatches(verified.amountGhs, Number(order.sale_amount), Number(order.payment_gross_amount));
      if (verifiedAmountMatches) {
        paymentConfirmed = true;
      } else if (verified?.state === 'failed') {
        paymentFailureReason = 'Skaipay payment was not successful.';
      } else {
        return {
          success: false,
          orderReference: order.reference,
          paymentStatus: 'pending',
          fulfilmentStatus: 'pending_payment',
          profitMargin: 0,
          message: 'Payment is not confirmed yet. Please wait a moment and try again.',
          recipient: order.recipient,
          bundleTitle: order.product_label,
        };
      }
    }
  } else {
    secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) throw new Error('Paystack secret key is not configured.');
    const verifiedRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const paystackData = await verifiedRes.json().catch(() => null);
    const expectedGross = Number(order.payment_gross_amount || 0) > 0
      ? Math.round(Number(order.payment_gross_amount) * 100)
      : Math.round((Number(order.sale_amount || 0) + Number(order.payment_fee || 0)) * 100);
    const amountMatches = !Number.isFinite(Number(paystackData?.data?.amount)) || expectedGross <= 0
      ? false
      : Number(paystackData.data.amount) === expectedGross;
    paymentConfirmed = verifiedRes.ok
      && paystackData?.data?.status === 'success'
      && paystackData.data.currency === 'GHS'
      && amountMatches;
    if (!paymentConfirmed) {
      paymentFailureReason = paystackData?.data?.gateway_response || paystackData?.message || 'Payment verification failed.';
    }
  }

  if (!paymentConfirmed) {
    await admin.from('store_orders').update({
      payment_status: 'failed',
      fulfilment_status: 'failed',
      failure_reason: paymentFailureReason,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);

    return {
      success: false,
      orderReference: order.reference,
      paymentStatus: 'failed',
      fulfilmentStatus: 'failed',
      profitMargin: 0,
      message: paymentFailureReason,
      recipient: order.recipient,
      bundleTitle: order.product_label,
    };
  }

  // 3. Calculate the customer margin. Public storefront payments fund the
  // fulfilment directly; the owner does not need to pre-fund a wallet.
  const saleAmount = Number(order.sale_amount || 0);
  const platformPrice = Number(order.platform_price || 0);
  const profitMargin = Math.max(0, round2(saleAmount - platformPrice));
  // Existing historical rows may already have a wallet debit; preserve that
  // flag so a later provider failure can still compensate the old debit.
  const walletDebited = order.wallet_debited === true;

  const paidAt = new Date().toISOString();
  await admin.from('store_orders').update({
    payment_status: 'paid',
    wallet_debited: walletDebited,
    paid_at: paidAt,
    updated_at: paidAt,
  }).eq('id', order.id);

  // 4. Resolve package & dispatch data bundle to recipient
  const networkType = String(order.network || '').toLowerCase();
  const parsed = volumeForBundleId(order.product_ref || '');
  const volumeInMB = parsed?.volumeInMB || Number(order.meta?.volume_mb) || 1024;

  const dataPackage = await resolveDataPackage(networkType, volumeInMB);
  let dispatch: DataBuyResult;

  if (!dataPackage) {
    dispatch = {
      success: false,
      provider: 'swift',
      status: 'failed',
      payload: { error: 'Package temporarily unavailable from provider.' },
      failureReason: 'Package temporarily unavailable from provider.',
    };
  } else {
    try {
      dispatch = await buyDataPackage(dataPackage, networkType, order.recipient);
    } catch (err) {
      const errStr = err instanceof Error ? err.message : 'Provider dispatch error';
      dispatch = {
        success: false,
        provider: dataPackage.provider,
        status: 'failed',
        payload: { error: errStr },
        failureReason: errStr,
      };
    }
  }

  // 5. Update order fulfilment status. A failed provider call reverses the
  // wallet debit; the public customer payment is refunded when Paystack allows.
  const providerResponse = {
    ...dispatch.payload,
    provider: dataPackage?.provider || 'unknown',
    providerOrderId: dispatch.orderId ?? null,
    providerReference: dispatch.providerReference ?? null,
    providerStatus: dispatch.status || null,
  };

  // Provider acceptance is not delivery confirmation. Live status polling will
  // move this order to successful/failed after Swift or GrandTech confirms it.
  const fulfilmentStatus = dispatch.success ? 'processing' : 'failed';
  let walletRefunded = false;
  let walletRefundError: string | null = null;
  if (!dispatch.success && order.agent_id && walletDebited) {
    try {
      await refundWallet(order.agent_id, reference, platformPrice, `Refund for failed store order ${reference}`);
      walletRefunded = true;
    } catch (error) {
      walletRefundError = error instanceof Error ? error.message : 'Wallet refund could not be completed.';
      console.error('Store order wallet refund failed:', error);
    }
  }
  const paystackRefunded = !dispatch.success && paymentProvider === 'paystack' && secret
    ? await requestPaystackRefund(secret, reference)
    : false;
  await admin.from('store_orders').update({
    payment_status: !dispatch.success && paystackRefunded ? 'refunded' : 'paid',
    wallet_debited: dispatch.success ? walletDebited : !walletRefunded,
    fulfilment_status: fulfilmentStatus,
    provider: dataPackage?.provider || null,
    provider_reference: dispatch.orderId ?? dispatch.providerReference ?? null,
    provider_response: providerResponse,
    failure_reason: dispatch.success ? null : [
      dispatch.failureReason || 'Provider could not deliver bundle.',
      walletRefundError ? `Wallet refund failed: ${walletRefundError}` : null,
      paystackRefunded || paymentProvider === 'hubtel' ? null : 'Customer payment refund is pending manual review.',
    ].filter(Boolean).join(' '),
    agent_earning: profitMargin,
    completed_at: fulfilmentStatus === 'processing' ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);

  if (fulfilmentStatus === 'successful') await creditStoreProfit(admin, order.id);

  return {
    success: dispatch.success,
    orderReference: order.reference,
    paymentStatus: dispatch.success ? 'paid' : (paystackRefunded ? 'refunded' : 'paid'),
    fulfilmentStatus,
    profitMargin,
    message: dispatch.success
      ? `Payment verified! ${order.product_label || 'Bundle'} is being delivered to ${order.recipient}.`
      : `Payment verified. Delivery notice: ${dispatch.failureReason || 'Pending provider confirmation.'}`,
    recipient: order.recipient,
    bundleTitle: order.product_label,
  };
}

async function requestPaystackRefund(secret: string, reference: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: reference }),
    });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.status === true;
  } catch (error) {
    console.error('Paystack store-order refund request failed:', error);
    return false;
  }
}
