import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = await requireAdmin(request);
    const body = await request.json();

    if (body.action === 'list') {
      const status = String(body.status ?? 'pending');
      const query = admin.from('cashout_deposit_requests')
        .select('id, amount, payer_phone, status, settlement_reference, admin_note, requested_at, reviewed_at, agent_id, agents(full_name, agent_code)')
        .order('requested_at', { ascending: false }).limit(100);
      if (status !== 'all') query.eq('status', status);
      const { data, error } = await query;
      if (error) throw error;
      return json({ requests: data ?? [] });
    }

    if (body.action === 'review') {
      const requestId = String(body.requestId ?? '');
      const decision = String(body.decision ?? '');
      if (!requestId || !['approve', 'reject'].includes(decision)) return json({ error: 'Select a valid request and decision.' }, 400);
      const { data, error } = await admin.rpc('review_cashout_deposit_request', {
        p_request_id: requestId,
        p_approved: decision === 'approve',
        p_settlement_reference: String(body.settlementReference ?? ''),
        p_admin_note: String(body.note ?? ''),
        p_admin_id: user.id,
      });
      if (error) throw error;
      return json({ request: data });
    }

    return json({ error: 'Unsupported action.' }, 400);
  } catch (error) {
    console.error(error);
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : 'Unable to manage cashout deposit requests.';
    return json({ error: message }, 500);
  }
});
