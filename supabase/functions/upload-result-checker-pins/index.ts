import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin } = await requireAdmin(request);
    const { examType, pins } = await request.json();
    if (!['BECE', 'WASSCE', 'NOV/DEC'].includes(examType) || !Array.isArray(pins) || !pins.length) {
      return json({ error: 'A valid exam type and at least one PIN are required.' }, 400);
    }
    const rows = pins.slice(0, 1000).map((item: { pin?: string; serial?: string }) => ({
      exam_type: examType, pin: String(item.pin || '').trim(), serial: String(item.serial || '').trim() || null,
    })).filter((item: { pin: string }) => item.pin);
    if (!rows.length) return json({ error: 'No valid PINs were supplied.' }, 400);
    const { data, error } = await admin.from('result_checker_pins').upsert(rows, { onConflict: 'exam_type,pin', ignoreDuplicates: true }).select('id');
    if (error) throw error;
    return json({ added: data?.length || 0, skipped: rows.length - (data?.length || 0) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'PIN upload failed.' }, 403);
  }
});
