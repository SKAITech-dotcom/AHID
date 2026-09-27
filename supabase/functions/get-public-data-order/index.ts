import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { dataOrderStuckMinutes, fetchDataOrderStatus } from '../_shared/dataProvider.ts';
import { refundWallet } from '../_shared/wallet.ts';

/**
 * Order status for the storefront, and the point where delivery is actually
 * confirmed.
 *
 * The provider accepts an order long before the bundle lands and can leave it
 * PENDING/PROCESSING indefinitely, so the customer polling their reference is
 * what drives reconciliation: we ask the provider, then either confirm
 * delivery or refund the agent.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference, email } = await request.json();
    if (!reference || !email) return json({ error: 'Reference and email are required.' }, 400);

    const supabase = adminClient();
    const { data, error } = await supabase
      .from('public_data_orders')
      .select('id, payment_reference, buyer_agent_id, network_type, volume_mb, sale_amount, status, created_at, provider_response')
      .eq('payment_reference', String(reference))
      .eq('customer_email', String(email).trim().toLowerCase())
      .single();
    if (error || !data) return json({ error: 'Order not found.' }, 404);

    let status = data.status as string;
    let note: string | null = null;

    if (status === 'processing') {
      const stored = (data.provider_response || {}) as Record<string, unknown>;
      const provider = String(stored.provider || 'grandtech');
      const providerOrderId = String(stored.providerOrderId ?? '');

      const live = providerOrderId
        ? await fetchDataOrderStatus(provider as 'grandtech', providerOrderId)
        : null;

      if (live?.state === 'successful') {
        status = 'successful';
        await supabase.rpc('mark_public_data_order', {
          p_order_id: data.id,
          p_status: 'successful',
          p_provider_amount: null,
          p_provider_reference: null,
          p_provider_response: { ...stored, lastProviderStatus: live.status },
        });
      } else if (live?.state === 'failed') {
        status = 'failed';
        await supabase.rpc('mark_public_data_order', {
          p_order_id: data.id,
          p_status: 'failed',
          p_provider_amount: null,
          p_provider_reference: null,
          p_provider_response: { ...stored, lastProviderStatus: live.status },
        });
      } else {
        // Still in flight. If the provider has had long enough, treat the order
        // as dropped rather than leaving the customer paid and waiting.
        const ageMinutes = (Date.now() - new Date(data.created_at).getTime()) / 60000;
        if (ageMinutes > dataOrderStuckMinutes()) {
          status = 'failed';
          note = 'The provider did not deliver this bundle in time and the order was refunded.';
          await supabase.rpc('mark_public_data_order', {
            p_order_id: data.id,
            p_status: 'failed',
            p_provider_amount: null,
            p_provider_reference: null,
            p_provider_response: { ...stored, lastProviderStatus: live?.status ?? 'TIMED_OUT' },
          });
        }
      }

      if (status === 'failed' && data.buyer_agent_id) {
        await refundWallet(
          data.buyer_agent_id,
          String(data.payment_reference),
          Number(data.sale_amount),
          'Instant data bundle not delivered',
        ).catch((err) => console.error('Data delivery refund failed:', err));
      }
    }

    const { data: fresh } = await supabase
      .from('public_data_orders')
      .select('payment_reference, network_type, volume_mb, sale_amount, status, created_at')
      .eq('id', data.id)
      .single();

    return json({ order: fresh ?? { ...data, status }, note });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to retrieve order.' }, 500);
  }
});
