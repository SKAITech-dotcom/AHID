import { adminClient, corsPreflight, getOptionalAgent, json } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json();
    const fullName = String(body.fullName || '').trim();
    const phone = String(body.phone || '').trim();
    const town = String(body.town || '').trim();
    const idType = String(body.idType || '').trim();
    const idNumber = String(body.idNumber || '').trim();

    if (!fullName || !phone || !town || !idType || !idNumber) {
      return json({ error: 'All registration fields are required.' }, 400);
    }

    const requester = await getOptionalAgent(request);
    const reference = `AFA-${crypto.randomUUID()}`;
    const amount = 8.00;

    const { data, error } = await adminClient()
      .from('afa_registrations')
      .insert({
        reference,
        full_name: fullName,
        phone,
        town,
        id_type: idType,
        id_number: idNumber,
        amount,
        status: 'Pending',
        source: requester ? 'agent' : 'public',
        created_by: requester?.agent?.id ?? null,
      })
      .select('reference, full_name, phone, town, id_type, id_number, amount, status, created_at')
      .single();

    if (error) throw error;

    return json({
      registration: data,
      message: 'AFA Registration submitted successfully! You can now track your status.',
    }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to submit registration.' }, 500);
  }
});