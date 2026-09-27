import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { activeDataProvider, dataOrderStuckMinutes, fetchDataOrderStatus } from '../_shared/dataProvider.ts';

/**
 * Reconciles the agent's own data bundle orders against the provider.
 *
 * The agent dashboard calls this whenever the orders page is opened, because a
 * data bundle is delivered asynchronously: the provider accepting the order only
 * means it reserved our balance, so the order sits in 'processing' until this
 * confirms the real outcome. Delivered bundles settle as 'successful'; failed or
 * cancelled ones settle as failed/cancelled, which refunds the agent's wallet
 * exactly once inside settle_agent_data_order.
 */

const MAX_ORDERS_PER_SYNC = 20;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = await requireAgent(request);

    const body = await request.json().catch(() => ({}));
    const orderReference = body?.orderReference ? String(body.orderReference) : null;

    const supabase = adminClient();

    let query = supabase
      .from('agent_data_orders')
      .select('id, provider_reference, provider_name, provider_order_id, network_type, volume_mb, amount, status, created_at, provider_response')
      .eq('agent_id', user.id)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: true })
      .limit(MAX_ORDERS_PER_SYNC);

    if (orderReference) query = query.eq('provider_reference', orderReference);

    const { data: orders, error } = await query;
    if (error) throw error;

    const stuckMinutes = dataOrderStuckMinutes();
    let changed = 0;

    for (const order of orders ?? []) {
      const providerName = String(order.provider_name || activeDataProvider());
      const providerOrderId = String(order.provider_order_id || '');

      const live = providerOrderId
        ? await fetchDataOrderStatus(providerName as 'grandtech', providerOrderId).catch((err) => {
          console.error('Data status check failed:', err);
          return null;
        })
        : null;

      if (live && (live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled')) {
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: live.state,
          p_provider_response: { lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Settle failed:', settleError);
        else changed += 1;
        continue;
      }

      // No live answer from the provider. If it has had long enough, the bundle
      // is never going to land, so release the agent's money rather than leaving
      // them paid and waiting.
      const ageMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;
      if (ageMinutes > stuckMinutes) {
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: 'failed',
          p_provider_response: { lastProviderStatus: live?.status ?? 'TIMED_OUT', checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Stuck-order settle failed:', settleError);
        else changed += 1;
      }
    }

    const { data: fresh } = await supabase
      .from('agent_data_orders')
      .select('id, provider_reference, short_code, provider_order_id, network_type, volume_mb, amount, status, created_at, completed_at')
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    // Provider reconciliation is not a row write of its own, so record it
    // explicitly in the activity log alongside the table triggers.
    if (changed > 0) {
      await admin.rpc('log_activity', {
        p_summary: `Reconciled ${changed} data bundle order${changed === 1 ? '' : 's'} with the provider`,
        p_meta: { changed, stuckMinutes },
        p_actor_user_id: user.id,
      }).catch((err) => console.error('Activity log write failed:', err));
    }

    return json({ success: true, changed, orders: fresh ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sync data orders.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
