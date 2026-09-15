import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Please sign in before submitting a deposit request.' }, 401);

    const { amount, phone } = await request.json();
    const value = Math.round(Number(amount) * 100) / 100;
    const payerPhone = String(phone ?? '').trim();
    if (!Number.isFinite(value) || value < 50 || value > 10000) {
      return json({ error: 'Enter a deposit amount between GHS 50.00 and GHS 10,000.00.' }, 400);
    }
    if (!/^0\d{9}$/.test(payerPhone)) return json({ error: 'Enter a valid 10-digit Ghanaian MoMo number.' }, 400);

    const admin = adminClient();
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: 'Your session is invalid. Please sign in again.' }, 401);

    const { data, error } = await admin.from('cashout_deposit_requests').insert({
      agent_id: user.id, amount: value, payer_phone: payerPhone,
    }).select('id, amount, status, requested_at').single();
    if (error?.code === '23505') return json({ error: 'You already have a pending cashout deposit request. Wait for it to be reviewed first.' }, 409);
    if (error) throw error;
    return json({ request: data }, 201);
  } catch (error) {
    console.error(error);
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : 'Unable to submit the cashout deposit request.';
    return json({ error: message }, 500);
  }
});
