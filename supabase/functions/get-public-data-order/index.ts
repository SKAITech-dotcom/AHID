import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference, email } = await request.json();
    if (!reference || !email) return json({ error: 'Reference and email are required.' }, 400);
    const { data, error } = await adminClient().from('public_data_orders')
      .select('payment_reference, network_type, volume_mb, sale_amount, status, created_at')
      .eq('payment_reference', String(reference)).eq('customer_email', String(email).trim().toLowerCase()).single();
    if (error || !data) return json({ error: 'Order not found.' }, 404);
    return json({ order: data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to retrieve order.' }, 500);
  }
});