import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { query } = await request.json();
    const term = String(query || '').trim().toLowerCase();
    if (!term) return json({ error: 'Please enter your phone number or ID number.' }, 400);

    const { data, error } = await adminClient()
      .from('afa_registrations')
      .select('reference, full_name, phone, town, id_type, id_number, amount, status, created_at')
      .or(`phone.ilike.${term},id_number.ilike.${term},reference.ilike.${term},full_name.ilike.${term}`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    if (!data || data.length === 0) return json({ error: 'No active AFA registration matched.' }, 404);

    return json({ registrations: data });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to retrieve registration.' }, 500);
  }
});