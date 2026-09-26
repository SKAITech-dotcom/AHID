import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';

const prices: Record<string, number> = { BECE: 19, WASSCE: 22, 'NOV/DEC': 22 };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;

  try {
    const { examType, quantity, email, phone } = await request.json();
    const price = prices[examType];
    const count = Number(quantity);
    if (!price || !Number.isInteger(count) || count < 1 || count > 10 || !/^\S+@\S+\.\S+$/.test(email || '') || !String(phone || '').trim()) {
      return json({ error: 'Enter a valid exam type, quantity, email, and phone number.' }, 400);
    }

    // WALLET-FIRST: results checker is paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    const { count: stock, error: stockError } = await admin.from('result_checker_pins')
      .select('*', { count: 'exact', head: true }).eq('exam_type', examType).eq('status', 'available');
    if (stockError) throw stockError;
    if ((stock || 0) < count) return json({ error: `Only ${stock || 0} ${examType} PIN(s) are available.` }, 409);

    const amount = price * count;
    reference = `RC-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(agentId, reference, amount, 'Results checker purchase', {
      service: 'result_checker',
      exam_type: examType,
      quantity: count,
    });

    const { data: order, error: orderError } = await admin.from('results_orders').insert({
      exam_type: examType, quantity: count, amount, recipient_phone: phone.trim(),
      email: email.trim().toLowerCase(), payment_reference: reference, status: 'pending_payment',
      serial_pin: null, agent_id: agentId,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    const { data: pins, error: fulfilError } = await admin.rpc('fulfil_result_checker_order', { p_order_id: order.id });
    if (fulfilError) throw fulfilError;

    return json({
      success: true,
      walletBalance,
      reference,
      amount,
      status: 'paid',
      pins: Array.isArray(pins) ? pins : [],
      message: `Payment confirmed. ${count} ${examType} PIN(s) assigned.`,
    });
  } catch (error) {
    console.error('Results checker payment error:', error);
    if (orderId && reference) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('results_orders')
          .select('amount, status')
          .eq('id', orderId)
          .maybeSingle();
        if (order && order.status !== 'paid') {
          await refundWallet(
            String(order.agent_id ?? ''),
            reference,
            Number(order.amount),
            'Results checker fulfilment failed',
          ).catch(() => {});
          await admin.from('results_orders').update({ status: 'failed' }).eq('id', orderId);
        }
      } catch (innerError) {
        console.error('Results checker refund failed:', innerError);
      }
    }
    const message = error instanceof Error ? error.message : 'Unable to process results checker purchase.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : message.toLowerCase().includes('insufficient')
      ? 400
      : /insufficient pin stock/i.test(message)
      ? 409
      : 500;
    return json({ error: message, insufficientFunds: message.toLowerCase().includes('insufficient') || undefined }, status);
  }
});