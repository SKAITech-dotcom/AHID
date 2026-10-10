import { corsPreflight, json } from '../_shared/supabase.ts';
import { hubtelConfigured } from '../_shared/hubtelDataProvider.ts';

/**
 * Serves the instant-data catalog: which networks exist, and which bundles are
 * sellable on each.
 *
 * Public and unauthenticated, like the existing list-data-bundles: a bundle list
 * is not sensitive, and the header card has to render before anyone signs in.
 * It reads through the caller's own token (anon key when there is none) rather
 * than the service key, so RLS decides what comes back and the response cannot
 * accidentally start bypassing it.
 *
 * Only `is_available` bundles are returned. Unavailable rows are not sent to
 * the client and hidden there - they are excluded by the policy itself - so a
 * crafted request cannot ask for a bundle that no provider can deliver. That is
 * why the seeded bundles ship unavailable: availability is switched on once a
 * Hubtel package id is mapped, not before.
 *
 * `provider.configured` tells the page whether a delivery attempt is even
 * possible. Showing "delivery not available yet" is more useful than an empty
 * bundle list, and it means a half-finished deployment fails visibly rather
 * than looking like a platform with nothing to sell.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = Deno.env.get('SUPABASE_URL')!;
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';

    const supabase = createClient(url, token || anonKey, { auth: { persistSession: false } });

    const [networksResult, bundlesResult] = await Promise.all([
      supabase
        .from('networks')
        .select('id, name, brand_color, badge_text, tagline, phone_prefixes')
        .order('sort_order', { ascending: true }),
      supabase
        .from('bundles')
        .select('bundle_key, network_id, title, data_amount, volume_mb, price, category, validity, sort_order')
        .order('sort_order', { ascending: true }),
    ]);

    if (networksResult.error) throw networksResult.error;
    if (bundlesResult.error) throw bundlesResult.error;

    const bundles = (bundlesResult.data ?? []) as Record<string, unknown>[];

    const networks = ((networksResult.data ?? []) as Record<string, unknown>[])
      .map((network) => ({
        id: String(network.id),
        name: String(network.name),
        brandColor: String(network.brand_color),
        badgeText: String(network.badge_text ?? ''),
        tagline: String(network.tagline ?? ''),
        phonePrefixes: Array.isArray(network.phone_prefixes) ? (network.phone_prefixes as unknown[]).map(String) : [],
        bundles: bundles
          .filter((bundle) => String(bundle.network_id) === String(network.id))
          .map((bundle) => ({
            bundleKey: String(bundle.bundle_key),
            title: String(bundle.title),
            dataAmount: String(bundle.data_amount),
            volumeMb: Number(bundle.volume_mb),
            price: Number(bundle.price),
            category: String(bundle.category ?? 'Standard'),
            // Validity is passed through only when the provider supplied one. A
            // placeholder like "30 days" must never be substituted for null.
            validity: bundle.validity ? String(bundle.validity) : null,
          })),
      }))
      // A network with nothing sellable on it would render an empty tab the
      // customer cannot act on, so it is dropped rather than shown.
      .filter((network) => network.bundles.length > 0);

    return json({
      networks,
      provider: { name: 'hubtel', configured: hubtelConfigured() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the data catalog.';
    console.error('data-catalog failed:', message);
    return json({ error: 'Unable to load data bundles right now. Please try again.' }, 500);
  }
});