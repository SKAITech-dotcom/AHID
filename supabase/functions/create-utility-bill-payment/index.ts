import { adminClient, corsPreflight, getOptionalAgent, json } from '../_shared/supabase.ts';

const VALID_BILL_TYPES: Record<string, 'electricity' | 'water' | 'tv'> = {
  ecg: 'electricity',
  ghana_water: 'water',
  dstv: 'tv',
  gotv: 'tv',
  startimes: 'tv',
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
    const billType = String(body.billType ?? '').trim().toLowerCase();
    const accountNumber = String(body.accountNumber ?? '').trim();
    const meterType = body.meterType ? String(body.meterType).trim() : null;
    const packageName = body.packageName ? String(body.packageName).trim() : null;
    const customerName = body.customerName ? String(body.customerName).trim() : null;
    const customerPhone = String(body.customerPhone ?? '').trim();
    const customerEmail = String(body.customerEmail ?? '').trim().toLowerCase();
    const amountVal = Number(body.amount);

    const billCategory = VALID_BILL_TYPES[billType];
    if (!billCategory) {
      return json({ error: 'Invalid utility bill type selected.' }, 400);
    }

    if (!accountNumber || accountNumber.length < 4 || accountNumber.length > 30) {
      return json({ error: 'Please enter a valid meter, account, or smartcard number.' }, 400);
    }

    if (!/^0\d{9}$/.test(customerPhone)) {
      return json({ error: 'Please enter a valid 10-digit Ghanaian phone number (e.g., 024XXXXXXX).' }, 400);
    }

    if (!/^\S+@\S+\.\S+$/.test(customerEmail)) {
      return json({ error: 'Please enter a valid email address for your payment receipt.' }, 400);
    }

    if (!Number.isFinite(amountVal) || amountVal < 5 || amountVal > 10000) {
      return json({ error: 'Please enter an amount between GHS 5.00 and GHS 10,000.00.' }, 400);
    }

    const netAmount = Math.round(amountVal * 100) / 100;
    const grossAmount = getCustomerCoveredGrossAmount(netAmount);
    const feeAmount = Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100;

    const optionalAgent = await getOptionalAgent(request);
    const agentId = optionalAgent?.user?.id ?? null;

    const reference = `UTIL-${crypto.randomUUID()}`;
    const admin = adminClient();

    const { data: order, error: orderError } = await admin.from('utility_orders').insert({
      bill_type: billType,
      bill_category: billCategory,
      account_number: accountNumber,
      meter_type: meterType,
      package_name: packageName,
      amount: netAmount,
      fee_amount: feeAmount,
      gross_amount: grossAmount,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      payment_reference: reference,
      status: 'pending_payment',
      agent_id: agentId,
    }).select('id').single();

    if (orderError) throw orderError;

    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const siteUrl = Deno.env.get('SITE_URL');
    if (!paystackSecret || !siteUrl) {
      throw new Error('Payment configuration is missing (PAYSTACK_SECRET_KEY or SITE_URL).');
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
        callback_url: `${siteUrl}/utilityBills.html?reference=${encodeURIComponent(reference)}`,
        metadata: {
          payment_type: 'utility_bill',
          utility_order_id: order.id,
          bill_type: billType,
          bill_category: billCategory,
          account_number: accountNumber,
          customer_phone: customerPhone,
          net_amount: netAmount,
          fee_amount: feeAmount,
          gross_amount: grossAmount,
          agent_id: agentId,
        },
      }),
    });

    const payment = await paystackResponse.json();
    if (!paystackResponse.ok || !payment.status || !payment.data?.authorization_url) {
      throw new Error(payment.message || 'Paystack rejected checkout initialization.');
    }

    return json({
      authorizationUrl: payment.data.authorization_url,
      reference,
      netAmount,
      feeAmount,
      grossAmount,
    });
  } catch (error) {
    console.error('Utility bill payment initialization error:', error);
    const message = error instanceof Error ? error.message : 'Unable to start utility bill payment.';
    return json({ error: message }, 500);
  }
});
