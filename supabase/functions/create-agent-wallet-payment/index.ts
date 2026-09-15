import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

function getCustomerCoveredGrossAmount(netAmount: number) {
  const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
  const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
  return Math.round(((netAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Please sign in before funding your wallet.' }, 401);
    const admin = adminClient();
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user?.email) return json({ error: 'Your session is invalid. Please sign in again.' }, 401);
    const { amount } = await request.json();
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 1 || value > 10000) return json({ error: 'Enter an amount between GHS 1.00 and GHS 10,000.00.' }, 400);
    const netAmount = Math.round(value * 100) / 100;
    const grossAmount = getCustomerCoveredGrossAmount(netAmount);
    const feeAmount = Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100;
    const reference = `WAL-${crypto.randomUUID()}`;
    const { data: topup, error: topupError } = await admin.from('wallet_topups').insert({
      agent_id: user.id,
      amount: netAmount,
      payment_reference: reference,
    }).select('id').single();
    if (topupError) throw topupError;
    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const siteUrl = Deno.env.get('SITE_URL');
    if (!secret || !siteUrl) throw new Error('Wallet payments are not configured yet.');
    if (!/^https?:\/\//i.test(siteUrl)) throw new Error('SITE_URL must be a complete http or https URL.');
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(grossAmount * 100),
        currency: 'GHS',
        reference,
        callback_url: `${siteUrl}/deposit.html?reference=${encodeURIComponent(reference)}`,
        metadata: {
          payment_type: 'wallet_topup',
          wallet_topup_id: topup.id,
          agent_id: user.id,
          net_amount: netAmount,
          fee_amount: feeAmount,
          gross_amount: grossAmount,
        },
      }),
    });
    const payment = await response.json();
    if (!response.ok || payment.status !== true || !payment.data?.authorization_url) {
      throw new Error(payment.message || `Paystack rejected checkout initialization (${response.status}).`);
    }
    return json({ authorizationUrl: payment.data.authorization_url, reference, netAmount, feeAmount, grossAmount });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Unable to start wallet payment.' }, 500);
  }
});
