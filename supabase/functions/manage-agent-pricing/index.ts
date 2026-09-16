import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    if (request.method === 'GET') {
      const { data, error } = await admin
        .from('agent_pricing')
        .select('pricing_key, price, updated_at')
        .eq('agent_id', user.id);

      if (error) throw error;
      const prices: Record<string, number> = {};
      (data || []).forEach((row: { pricing_key: string; price: number }) => {
        prices[row.pricing_key] = Number(row.price);
      });
      return json({ prices });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const prices = body.prices;
      if (!prices || typeof prices !== 'object') {
        return json({ error: 'Invalid pricing payload.' }, 400);
      }

      const rowsToUpsert = Object.entries(prices)
        .filter(([key, val]) => typeof key === 'string' && key.startsWith('price_') && Number.isFinite(Number(val)) && Number(val) >= 0)
        .map(([key, val]) => ({
          agent_id: user.id,
          pricing_key: key,
          price: Math.round(Number(val) * 100) / 100,
          updated_at: new Date().toISOString(),
        }));

      if (rowsToUpsert.length === 0) {
        return json({ error: 'No valid prices provided to update.' }, 400);
      }

      const { error: upsertError } = await admin
        .from('agent_pricing')
        .upsert(rowsToUpsert, { onConflict: 'agent_id,pricing_key' });

      if (upsertError) throw upsertError;
      return json({ success: true, count: rowsToUpsert.length });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-agent-pricing error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process agent pricing request.';
    const status = message.includes('Authentication') ? 401 : message.includes('Verified agent') ? 403 : 500;
    return json({ error: message }, status);
  }
});
