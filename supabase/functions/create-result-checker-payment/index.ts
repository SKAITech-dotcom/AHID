import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

const prices: Record<string, number> = { BECE: 19, WASSCE: 22, 'NOV/DEC': 22 };

function getCustomerCoveredGrossAmount(netAmount: number) {
  const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
  const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
  return Math.round(((netAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { examType, quantity, email, phone } = await request.json();
    const amount = prices[examType];
    const count = Number(quantity);
    if (!amount || !Number.isInteger(count) || count < 1 || count > 10 || !/^\S+@\S+\.\S+$/.test(email || '') || !String(phone || '').trim()) {
      return json({ error: 'Enter a valid exam type, quantity, email, and phone number.' }, 400);
    }
    const admin = adminClient();
    const { count: stock, error: stockError } = await admin.from('result_checker_pins')
      .select('*', { count: 'exact', head: true }).eq('exam_type', examType).eq('status', 'available');
    if (stockError) throw stockError;
    if ((stock || 0) < count) return json({ error: `Only ${stock || 0} ${examType} PIN(s) are available.` }, 409);

    const reference = `RC-${crypto.randomUUID()}`;
    const { data: order, error: orderError } = await admin.from('results_orders').insert({
      exam_type: examType, quantity: count, amount: amount * count, recipient_phone: phone.trim(),
      email: email.trim().toLowerCase(), payment_reference: reference, status: 'pending_payment', serial_pin: null,
    }).select('id').single();
    if (orderError) throw orderError;

    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const siteUrl = Deno.env.get('SITE_URL');
    if (!paystackSecret || !siteUrl) throw new Error('PAYSTACK_SECRET_KEY and SITE_URL must be configured.');
    const netAmount = amount * count;
    const grossAmount = getCustomerCoveredGrossAmount(netAmount);
    const feeAmount = Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100;
    const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${paystackSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: Math.round(grossAmount * 100), currency: 'GHS', reference,
        callback_url: `${siteUrl}/resultsChecker.html?reference=${encodeURIComponent(reference)}`,
        metadata: { result_order_id: order.id, exam_type: examType, quantity: count, net_amount: netAmount, fee_amount: feeAmount, gross_amount: grossAmount }, }),
    });
    const paystack = await paystackResponse.json();
    if (!paystackResponse.ok || !paystack.status) throw new Error(paystack.message || 'Paystack could not initialize the payment.');
    return json({ authorizationUrl: paystack.data.authorization_url, reference, netAmount, feeAmount, grossAmount });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Unable to start payment.' }, 500);
  }
});
