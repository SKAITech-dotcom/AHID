import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';

const VALID_BILL_TYPES: Record<string, 'electricity' | 'water' | 'tv'> = {
  ecg: 'electricity',
  ghana_water: 'water',
  dstv: 'tv',
  gotv: 'tv',
  startimes: 'tv',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;
  let agentId = '';

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

    // WALLET-FIRST: utilities are paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;
    const netAmount = Math.round(amountVal * 100) / 100;

    reference = `UTIL-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(agentId, reference, netAmount, 'Utility bill payment', {
      service: 'utility_bill',
      bill_type: billType,
      account_number: accountNumber,
    });

    const { data: order, error: orderError } = await admin.from('utility_orders').insert({
      bill_type: billType,
      bill_category: billCategory,
      account_number: accountNumber,
      meter_type: meterType,
      package_name: packageName,
      amount: netAmount,
      fee_amount: 0,
      gross_amount: netAmount,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      payment_reference: reference,
      status: 'processing',
      agent_id: agentId,
    }).select('id').single();

    if (orderError) throw orderError;
    orderId = order.id;

    const { data: fulfilled, error: fulfilError } = await admin.rpc('fulfil_utility_order', {
      p_order_id: order.id,
    });
    if (fulfilError) throw fulfilError;

    return json({
      success: true,
      walletBalance,
      reference,
      amount: netAmount,
      billType,
      status: fulfilled.status,
      token: fulfilled.token_code,
      customerPhone,
      message: fulfilled.bill_category === 'electricity'
        ? 'Your electricity token has been generated successfully.'
        : 'Your utility bill payment has been completed successfully.',
    });
  } catch (error) {
    console.error('Utility bill payment error:', error);
    if (orderId && reference) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('utility_orders')
          .select('amount, status')
          .eq('id', orderId)
          .maybeSingle();
        if (order && !['paid', 'completed'].includes(order.status)) {
          const amount = Number(order.amount);
          await refundWallet(agentId, reference, amount, 'Utility bill fulfilment failed');
          await admin.from('utility_orders').update({
            status: 'failed',
            provider_response: { error: error instanceof Error ? error.message : 'Fulfilment failed' },
            completed_at: new Date().toISOString(),
          }).eq('id', orderId);
        }
      } catch (innerError) {
        console.error('Utility refund/rollback failed:', innerError);
      }
    }
    const message = error instanceof Error ? error.message : 'Unable to process utility bill payment.';
    const status = message.includes('Authentication is required') || message.includes('session is invalid')
      ? 401
      : message.includes('Agent account required')
      ? 403
      : message.toLowerCase().includes('insufficient')
      ? 400
      : 500;
    return json({ error: message, insufficientFunds: message.toLowerCase().includes('insufficient') || undefined }, status);
  }
});