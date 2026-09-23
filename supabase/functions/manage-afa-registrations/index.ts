import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

const VALID_STATUSES = ['Pending', 'Processing', 'Completed', 'Cancelled'];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const query = (url.searchParams.get('query') || '').trim().toLowerCase();

      let supabaseQuery = admin
        .from('afa_registrations')
        .select('reference, full_name, phone, town, id_type, id_number, amount, status, source, created_at')
        .order('created_at', { ascending: false })
        .limit(200);

      if (query) {
        supabaseQuery = supabaseQuery.or(`phone.ilike.${query},id_number.ilike.${query},full_name.ilike.${query},reference.ilike.${query},town.ilike.${query}`);
      }

      const { data, error } = await supabaseQuery;
      if (error) throw error;
      return json({ registrations: data || [] });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const action = body.action;

      if (action === 'create') {
        const fullName = String(body.fullName || '').trim();
        const phone = String(body.phone || '').trim();
        const town = String(body.town || '').trim();
        const idNumber = String(body.idNumber || '').trim();

        if (!fullName || !phone || !town || !idNumber) {
          return json({ error: 'All registration fields are required.' }, 400);
        }

        const reference = `AFA-${crypto.randomUUID()}`;
        const { data, error } = await admin
          .from('afa_registrations')
          .insert({
            reference,
            full_name: fullName,
            phone,
            town,
            id_type: 'Ghana Card',
            id_number: idNumber,
            amount: 8.00,
            status: 'Pending',
            source: 'agent',
            created_by: user.id,
          })
          .select('reference, full_name, phone, town, id_type, id_number, amount, status, source, created_at')
          .single();

        if (error) throw error;
        return json({ registration: data }, 201);
      }

      if (action === 'update_status') {
        const reference = String(body.reference || '').trim();
        const status = String(body.status || '').trim();
        if (!reference || !VALID_STATUSES.includes(status)) {
          return json({ error: 'A valid reference and status are required.' }, 400);
        }

        const { data, error: updateError } = await admin
          .from('afa_registrations')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('reference', reference)
          .select('reference, full_name, phone, town, id_type, id_number, amount, status, source, created_at')
          .single();

        if (updateError) throw updateError;
        return json({ registration: data });
      }

      return json({ error: 'Unknown action.' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-afa-registrations error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process AFA request.';
    const status = message.includes('Authentication') ? 401 : 500;
    return json({ error: message }, status);
  }
});