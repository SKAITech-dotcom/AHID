import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

const catalog: Record<string, Record<number, number>> = {
  mtn: {
    1024: 4.2, 2048: 8.3, 3072: 12.2, 4096: 16.2, 5120: 20.5,
    6144: 24.8, 8192: 34, 10240: 40, 15360: 58.6, 20480: 78,
    25600: 98, 30720: 118, 40960: 156, 51200: 195, 102400: 375,
  },
  telecel: {
    5120: 18.5, 10240: 35, 11264: 39, 15360: 52, 16384: 58,
    20480: 69, 22528: 79, 25600: 86, 27648: 98, 30720: 103,
    33792: 114, 40960: 137, 45056: 150, 51200: 171, 102400: 357,
    112640: 370,
  },
  airteltigo: {
    1024: 4, 2048: 8, 3072: 12, 4096: 16, 5120: 20, 6144: 24,
    7168: 28, 8192: 32, 9216: 36, 30720: 65, 40960: 75, 51200: 90,
    61440: 110, 71680: 125, 81920: 150, 102400: 175, 153600: 220,
    204800: 330,
  },
};

function getCustomerCoveredGrossAmount(netAmount: number) {
  const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
  const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
  return Math.round(((netAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json();
    const networkType = String(body.networkType || '').trim().toLowerCase();
    const volumeInMB = Number(body.volumeInMB);
    const customerName = String(body.name || '').trim();
    const customerEmail = String(body.email || '').trim().toLowerCase();
    const customerPhone = String(body.phone || '').trim();
    const saleAmount = catalog[networkType]?.[volumeInMB];

    if (!customerName || customerName.length > 120 || !/^\S+@\S+\.\S+$/.test(customerEmail) || !/^0\d{9}$/.test(customerPhone) || !saleAmount) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    const reference = `PUB-${crypto.randomUUID()}`;
    const admin = adminClient();
    const { error } = await admin.from('public_data_orders').insert({
      payment_reference: reference, customer_name: customerName, customer_email: customerEmail,
      customer_phone: customerPhone, network_type: networkType, volume_mb: volumeInMB,
      sale_amount: saleAmount,
    });
    if (error) throw error;

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const siteUrl = Deno.env.get('SITE_URL');
    if (!secret || !siteUrl) throw new Error('Public data payments are not configured yet.');
    const grossAmount = getCustomerCoveredGrossAmount(saleAmount);
    const feeAmount = Math.round((grossAmount - saleAmount + Number.EPSILON) * 100) / 100;
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: customerEmail, amount: Math.round(grossAmount * 100), currency: 'GHS', reference,
        callback_url: `${siteUrl}/nonAgentBuyers.html?network=${networkType}&reference=${encodeURIComponent(reference)}`,
        metadata: { payment_type: 'public_data', public_order_id: reference, network_type: networkType, volume_mb: volumeInMB, net_amount: saleAmount, fee_amount: feeAmount, gross_amount: grossAmount }, }),
    });
    const payment = await response.json();
    if (!response.ok || payment.status !== true || !payment.data?.authorization_url) throw new Error(payment.message || 'Paystack could not initialize payment.');
    return json({ authorizationUrl: payment.data.authorization_url, reference, email: customerEmail, netAmount: saleAmount, feeAmount, grossAmount });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Unable to start payment.' }, 500);
  }
});
