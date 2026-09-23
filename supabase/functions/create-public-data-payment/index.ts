import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

const catalog: Record<string, Record<number, number>> = {
  mtn: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    2048: 8.8, 3072: 13.2, 4096: 17.6, 5120: 22, 6144: 26.1,
    8192: 34.8, 10240: 42, 15360: 63, 20480: 84, 25600: 103.75,
    30720: 121.5, 40960: 160, 51200: 200,
  },
  telecel: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    10240: 40, 15360: 60, 20480: 78, 30720: 114, 40960: 151, 51200: 185,
  },
  airteltigo: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    1024: 4.2, 2048: 8.39, 3072: 12.58, 4096: 16.78, 5120: 20.97,
    6144: 25.17, 7168: 29.36, 8192: 33.56, 9216: 37.53, 10240: 40.84,
    15360: 60.71,
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
