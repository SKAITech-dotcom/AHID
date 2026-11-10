import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { resolveDataPackage } from '../_shared/dataProvider.ts';
import { hubtelWalletGrossAmount } from '../_shared/paymentGateway.ts';
import { hubtelPaymentsConfigured, initializeHubtelCollection } from '../_shared/hubtelPayments.ts';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function paymentProviderForSale(saleAmount: number): 'hubtel' | 'paystack' {
  // GHS 10.00 through GHS 50.00 uses Paystack. Everything below GHS 10.00
  // or above GHS 50.00 uses Skaipay (Hubtel).
  return saleAmount >= 10 && saleAmount <= 50 ? 'paystack' : 'hubtel';
}

/** Creates a Hubtel checkout for a guest; no agent session or wallet is used. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const bundleId = String(body.bundleId || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    if (!bundleId || !/^0\d{9}$/.test(phone)) {
      return json({ error: 'Select a bundle and enter a valid 10-digit Ghana customer number.' }, 400);
    }

    const siteUrl = Deno.env.get('SITE_URL')?.trim();
    if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) {
      return json({ error: 'Guest data checkout is not configured yet. Please try again later.' }, 503);
    }

    const admin = adminClient();
    const { data: bundle, error: bundleError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, volume_mb, price, active, title')
      .eq('bundle_id', bundleId)
      .eq('active', true)
      .maybeSingle();
    if (bundleError) throw bundleError;
    if (!bundle) return json({ error: 'That bundle is no longer available. Refresh and choose another bundle.' }, 409);

    const { data: control, error: controlError } = await admin
      .from('non_agent_data_prices')
      .select('price_override, active')
      .eq('bundle_id', bundleId)
      .maybeSingle();
    if (controlError) throw controlError;
    if (control?.active === false) return json({ error: 'That bundle is temporarily unavailable.' }, 409);

    const saleAmount = roundMoney(control?.price_override == null ? Number(bundle.price) : Number(control.price_override));
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) return json({ error: 'This bundle has no valid selling price.' }, 409);

    // Confirm provider availability before taking payment. The provider cost is
    // still resolved again after Hubtel payment verification before fulfilment.
    const dataPackage = await resolveDataPackage(String(bundle.network), Number(bundle.volume_mb));
    if (!dataPackage) {
      return json({ error: 'This bundle is temporarily unavailable from its provider. No payment was started.' }, 409);
    }

    const paymentProvider = paymentProviderForSale(saleAmount);
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
    const feeRateValue = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
    const feeRate = Number.isFinite(feeRateValue) && feeRateValue >= 0 && feeRateValue < 1
      ? feeRateValue
      : 0.0195;
    const grossAmount = paymentProvider === 'hubtel'
      ? hubtelWalletGrossAmount(saleAmount)
      : roundMoney(saleAmount * (1 + feeRate));
    const feeAmount = roundMoney(grossAmount - saleAmount);

    if (paymentProvider === 'hubtel' && !hubtelPaymentsConfigured()) {
      return json({ error: 'Skaipay checkout is not configured yet. Please try again later.' }, 503);
    }
    if (paymentProvider === 'paystack' && !paystackSecret) {
      return json({ error: 'Paystack checkout is not configured yet. Please try again later.' }, 503);
    }

    // Hubtel limits clientReference to 32 characters. Keep the guest reference
    // short while retaining the old PUB-GUEST format for historical Paystack
    // orders handled by the verification route.
    const reference = `PUB${crypto.randomUUID().replaceAll('-', '').slice(0, 29)}`;
    const accessToken = crypto.randomUUID();
    const callbackUrl = `${siteUrl.replace(/\/$/, '')}/nonAgentBuyers.html?reference=${encodeURIComponent(reference)}`;
    const customerEmail = `guest-${reference.toLowerCase().replace(/[^a-z0-9-]/g, '')}@customers.skaitechgh.app`;
    const { data: order, error: orderError } = await admin.from('public_data_orders').insert({
      payment_reference: reference,
      public_access_token: accessToken,
      customer_name: 'Guest Customer',
      customer_email: customerEmail,
      customer_phone: phone,
      network_type: String(bundle.network).toLowerCase(),
      volume_mb: Number(bundle.volume_mb),
      sale_amount: saleAmount,
      paystack_fee_amount: paymentProvider === 'paystack' ? feeAmount : 0,
      paystack_gross_amount: paymentProvider === 'paystack' ? grossAmount : null,
      payment_fee_amount: feeAmount,
      payment_gross_amount: grossAmount,
      payment_provider: paymentProvider,
      provider_name: dataPackage.provider,
      provider_package_id: dataPackage.id,
      status: 'pending_payment',
    }).select('id, short_code').single();
    if (orderError) throw orderError;

    try {
      if (paymentProvider === 'hubtel') {
        const callbackSecret = Deno.env.get('HUBTEL_WALLET_CALLBACK_SECRET')?.trim();
        const configuredCallback = Deno.env.get('HUBTEL_WALLET_CALLBACK_URL')?.trim()
          || `${Deno.env.get('SUPABASE_URL')}/functions/v1/hubtel-webhook`;
        const hubtelCallbackUrl = callbackSecret
          ? (() => {
              const target = new URL(configuredCallback);
              target.searchParams.set('token', callbackSecret);
              return target.toString();
            })()
          : configuredCallback;
        const payment = await initializeHubtelCollection({
          reference,
          amountGhs: saleAmount,
          returnUrl: callbackUrl,
          callbackUrl: hubtelCallbackUrl,
          description: 'Skaitech guest data bundle',
        });
        await admin.from('public_data_orders').update({
          provider_response: { checkout: payment.payload, checkoutId: payment.orderId || null },
        }).eq('id', order.id);
        return json({
          success: true,
          authorizationUrl: payment.authorizationUrl,
          reference,
          accessToken,
          orderCode: order.short_code,
          amount: saleAmount,
          grossAmount,
          paymentProvider,
          gatewayLabel: 'Skaipay (Hubtel)',
        });
      }

      const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: customerEmail,
          amount: Math.round(grossAmount * 100),
          currency: 'GHS',
          reference,
          callback_url: callbackUrl,
          metadata: {
            payment_type: 'public_data',
            order_reference: reference,
            public_data_order_id: order.id,
            bundle_id: bundleId,
            network: bundle.network,
            volume_mb: bundle.volume_mb,
            customer_phone: phone,
            package_price: saleAmount,
            processing_fee: feeAmount,
            gross_amount: grossAmount,
          },
        }),
      });
      const payment = await paystackResponse.json().catch(() => ({}));
      if (!paystackResponse.ok || payment?.status !== true || !payment?.data?.authorization_url) {
        throw new Error(payment?.message || `Paystack checkout initialization failed (HTTP ${paystackResponse.status}).`);
      }
      const { error: checkoutSaveError } = await admin.from('public_data_orders').update({
        provider_response: {
          checkout: {
            authorizationUrl: payment.data.authorization_url,
            accessCode: payment.data.access_code || null,
          },
        },
      }).eq('id', order.id);
      if (checkoutSaveError) throw checkoutSaveError;
      return json({
        success: true,
        authorizationUrl: payment.data.authorization_url,
        accessCode: payment.data.access_code || null,
        reference,
        accessToken,
        orderCode: order.short_code,
        amount: saleAmount,
        grossAmount,
        paymentProvider,
        gatewayLabel: 'Paystack',
      });
    } catch (error) {
      await admin.from('public_data_orders').update({
        status: 'failed',
        provider_response: { paymentInitialization: error instanceof Error ? error.message : 'Hubtel could not start checkout.' },
        completed_at: new Date().toISOString(),
      }).eq('id', order.id);
      return json({ error: error instanceof Error ? error.message : 'Hubtel could not start checkout. No payment was taken.' }, 502);
    }
  } catch (error) {
    console.error('create-public-data-checkout failed:', error);
    return json({ error: errorMessage(error, 'Unable to start checkout. Please try again.') }, 500);
  }
});
