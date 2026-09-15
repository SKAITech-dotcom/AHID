import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin } = await requireAdmin(request);
    const { data, error } = await admin.from('result_checker_pins').select('exam_type, status');
    if (error) throw error;
    const stock = (data || []).reduce<Record<string, number>>((total, pin) => {
      if (pin.status === 'available') total[pin.exam_type] = (total[pin.exam_type] || 0) + 1;
      return total;
    }, {});
    return json({ stock });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to load stock.' }, 403);
  }
});
