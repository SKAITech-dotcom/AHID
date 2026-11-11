import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { hubtelWalletGrossAmount } from '../_shared/paymentGateway.ts';
import { hubtelPaymentsConfigured, initializeHubtelCollection } from '../_shared/hubtelPayments.ts';

const VALID_NETWORKS = new Set(['mtn', 'telecel', 'at']);

function generateShortCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join('');
}

function appendCallbackToken(url: string): string {
  const secret = Deno.env.get('HUBTEL_WALLET_CALLBACK_SECRET')?.trim();
  if (!secret) return url;
  const target = new URL(url);
  target.searchParams.set('token', secret);
  return target.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to start the Skaipay airtime checkout.';
}

/** Creates a phone-only guest airtime checkout. Delivery is started only by
 * verify-public-airtime-payment after Hubtel confirms the payment. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  let orderId = '';
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const network = String(body.network ?? '').trim().toLowerCase();
    const phone = String(body.phone ?? body.recipient ?? '').trim().replace(/[\s-]/g, '');
    const amount = Math.round(Number(body.amount) * 100) / 100;

    if (!VALID_NETWORKS.has(network)) {
      return json({ success: false, error: 'Select MTN, Telecel, or AT airtime.' }, 400);
    }
    if (!/^0\d{9}$/.test(phone)) {
      return json({ success: false, error: 'Enter a valid 10-digit Ghanaian recipient phone number.' }, 400);
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 100) {
      return json({ success: false, error: 'Airtime amount must be between GHS 1.00 and GHS 100.00.' }, 400);
    }
    if (!hubtelPaymentsConfigured()) {
      return json({ success: false, error: 'Skaipay checkout is not configured yet. Please try again later.' }, 503);
    }

    const siteUrl = Deno.env.get('SITE_URL')?.trim();
    if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) {
      return json({ success: false, error: 'Guest airtime checkout is not configured yet. Please try again later.' }, 503);
    }

    // Hubtel clientReference is limited to 32 characters.
    const reference = `PAI${crypto.randomUUID().replaceAll('-', '').slice(0, 29)}`;
    const accessToken = crypto.randomUUID();
    const admin = adminClient();
    const customerEmail = `guest-${reference.toLowerCase()}@customers.skaitechgh.app`;
    const grossAmount = hubtelWalletGrossAmount(amount);
    const { data: inserted, error: insertError } = await admin.from('airtime_orders').insert({
      payment_reference: reference,
      public_access_token: accessToken,
      recipient_phone: phone,
      network,
      amount,
      fee_amount: 0,
      gross_amount: amount,
      payment_method: 'hubtel',
      payment_status: 'pending_payment',
      airtime_status: 'pending',
      customer_name: 'Guest Customer',
      customer_email: customerEmail,
    }).select('id, short_code').single();
    if (insertError) throw insertError;
    orderId = String(inserted.id);

    let shortCode = String(inserted.short_code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(shortCode)) {
      shortCode = generateShortCode();
      await admin.from('airtime_orders').update({ short_code: shortCode }).eq('id', orderId);
    }

    const configuredCallback = Deno.env.get('HUBTEL_WALLET_CALLBACK_URL')?.trim()
      || `${Deno.env.get('SUPABASE_URL')}/functions/v1/hubtel-webhook`;
    const callbackUrl = appendCallbackToken(configuredCallback);
    const returnUrl = `${siteUrl.replace(/\/$/, '')}/airtime.html?reference=${encodeURIComponent(reference)}`;
    const checkout = await initializeHubtelCollection({
      reference,
      amountGhs: amount,
      returnUrl,
      callbackUrl,
      description: `Skaitech ${network.toUpperCase()} airtime`,
    });

    const { error: saveError } = await admin.from('airtime_orders').update({
      provider_response: { checkout: checkout.payload, checkoutId: checkout.orderId || null, expectedGrossAmount: grossAmount },
      provider_reference: checkout.orderId || null,
      updated_at: new Date().toISOString(),
    }).eq('id', orderId);
    if (saveError) throw saveError;

    return json({
      success: true,
      authorizationUrl: checkout.authorizationUrl,
      reference,
      accessToken,
      orderCode: shortCode,
      phone,
      network,
      amount,
      grossAmount,
      paymentProvider: 'hubtel',
      gatewayLabel: 'Skaipay (Hubtel)',
    });
  } catch (error) {
    console.error('[create-public-airtime-payment] failed:', error);
    if (orderId) {
      try {
        await adminClient().from('airtime_orders').update({
          payment_status: 'failed',
          airtime_status: 'failed',
          failure_reason: errorMessage(error),
          updated_at: new Date().toISOString(),
        }).eq('id', orderId).eq('payment_status', 'pending_payment');
      } catch (saveError) {
        console.error('[create-public-airtime-payment] failed-order update failed:', saveError);
      }
    }
    return json({ success: false, error: errorMessage(error) }, 502);
  }
});
