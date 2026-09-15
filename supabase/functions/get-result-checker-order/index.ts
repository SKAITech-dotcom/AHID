import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference, email } = await request.json();
    if (!reference || !email) return json({ error: 'Reference and email are required.' }, 400);
    const { data: order, error } = await adminClient().from('results_orders')
      .select('id, exam_type, quantity, amount, serial_pin, status, created_at')
      .eq('payment_reference', String(reference)).eq('email', String(email).trim().toLowerCase()).single();
    if (error || !order) return json({ error: 'Order not found.' }, 404);
    return json({ order: { ...order, pins: order.status === 'paid' ? JSON.parse(order.serial_pin || '[]') : [] } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to retrieve this order.' }, 500);
  }
});
