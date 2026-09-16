import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { reference, email } = await request.json();
    if (!reference || !email) {
      return json({ error: 'Payment reference and customer email are required.' }, 400);
    }

    const admin = adminClient();
    const { data: order, error } = await admin
      .from('utility_orders')
      .select('id, bill_type, bill_category, account_number, meter_type, package_name, amount, fee_amount, gross_amount, customer_name, customer_phone, customer_email, payment_reference, status, token_code, created_at, paid_at, completed_at')
      .eq('payment_reference', String(reference).trim())
      .eq('customer_email', String(email).trim().toLowerCase())
      .single();

    if (error || !order) {
      return json({ error: 'Utility bill order not found.' }, 404);
    }

    return json({ order });
  } catch (error) {
    console.error('get-utility-bill-order error:', error);
    const message = error instanceof Error ? error.message : 'Unable to retrieve this order.';
    return json({ error: message }, 500);
  }
});
