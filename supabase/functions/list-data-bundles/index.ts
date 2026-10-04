import { corsPreflight, json } from '../_shared/supabase.ts';
import { DATA_NETWORKS, type DataNetwork } from '../_shared/dataCatalog.ts';

/**
 * Serves the sellable bundle catalog, grouped by network.
 *
 * Public and unauthenticated on purpose: the storefront has to show a price and
 * a bundle before anyone signs in, and a bundle list is not sensitive. Only
 * active rows are returned, and the service key is used for the read so the
 * response shape does not depend on which role happens to be calling.
 *
 * The client renders exactly what this returns, so a bundle that the provider
 * cannot deliver cannot appear on screen: the sync function is what decides
 * which rows are active.
 *
 * `validity` is passed through as-is and is currently null for every row. The
 * UI must not substitute a placeholder like "30 days" for it.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // Read through the user's own token so RLS applies and we never bypass it
    // with a service key for a public table. Falls back to the anon client when
    // there is no session, which the active-row policy also permits.
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = Deno.env.get('SUPABASE_URL')!;
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';

    const supabase = createClient(url, token || anonKey, { auth: { persistSession: false } });

    const { data, error } = await supabase
      .from('bundle_catalog')
      .select('bundle_id, network, title, validity, volume_mb, price')
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;

    const networks = (data ?? []).map((row) => ({
      bundleId: String(row.bundle_id),
      network: String(row.network) as DataNetwork,
      title: String(row.title),
      validity: row.validity ? String(row.validity) : null,
      volumeMb: Number(row.volume_mb),
      price: Number(row.price),
    }));

    // Fixed network order, and drop networks we somehow have no rows for so the
    // client never renders an empty tab it cannot fill.
    const byNetwork = DATA_NETWORKS
      .map((network) => ({ network, bundles: networks.filter((b) => b.network === network) }))
      .filter((group) => group.bundles.length > 0);

    return json({ networks: byNetwork });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the bundle catalog.';
    console.error('list-data-bundles failed:', message);
    return json({ error: 'Unable to load data bundles right now. Please try again.' }, 500);
  }
});