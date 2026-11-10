import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus, recoverGrandTechOrderIdFromProvider, recoverGrandTechOrderIdFromStored } from '../_shared/dataProvider.ts';
import { refundWallet } from '../_shared/wallet.ts';
import { volumeForBundleId } from '../_shared/dataCatalog.ts';

/**
 * Reconciles the agent's own data orders against the provider.
 *
 * Checks live delivery status directly from the provider (GrandTech / Swift).
 * Delivered bundles settle as 'successful'.
 * Orders ONLY settle as 'failed' or 'cancelled' (and refund the wallet) when the
 * provider explicitly confirms that the order failed or was cancelled.
 *
 * Crucially: In-flight or unconfirmed orders are NEVER arbitrarily timed out
 * or auto-refunded to ensure the agent's wallet remains properly charged
 * for accepted orders.
 */

const MAX_ORDERS_PER_SYNC = 100;

async function recordStatusEvent(
  admin: any,
  event: {
    orderType: string;
    orderId: string;
    agentId?: string | null;
    provider: string;
    providerStatus: string;
    internalStatus: string;
    payload?: Record<string, unknown>;
  },
) {
  const { error } = await admin.rpc('record_provider_order_status', {
    p_order_type: event.orderType,
    p_order_id: event.orderId,
    p_agent_id: event.agentId || null,
    p_provider: event.provider,
    p_provider_status: event.providerStatus || 'UNKNOWN',
    p_internal_status: event.internalStatus,
    p_source: 'agent_reconciliation',
    p_payload: event.payload || {},
  });
  if (error) console.error('Provider status event write failed:', error);
}

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
      // Include successful rows whose last provider answer was still pending.
      // Older code could mark an accepted order successful before delivery;
      // those rows must be allowed back into reconciliation.
      .in('status', ['pending', 'processing', 'successful'])
      .order('created_at', { ascending: true })
      .limit(MAX_ORDERS_PER_SYNC);

    if (orderReference) query = query.eq('provider_reference', orderReference);

    const { data: orders, error } = await query;
    if (error) throw error;

    let changed = 0;

    for (const order of orders ?? []) {
      const existingResp = (order.provider_response && typeof order.provider_response === 'object') ? order.provider_response as Record<string, unknown> : {};
      const providerName = String(order.provider_name || existingResp.provider || activeDataProvider(order.network_type, Number(order.volume_mb)));
      const lastProviderStatus = String(existingResp.lastProviderStatus || existingResp.providerStatus || '').trim().toUpperCase();
      const lastProviderState = String(existingResp.lastProviderState || '').trim().toLowerCase();
      const isStaleSuccessful = order.status === 'successful' && (
        ['PENDING', 'PROCESSING', 'QUEUED', 'SUBMITTED', 'RECEIVED', 'ACCEPTED', 'INITIATED'].includes(lastProviderStatus) ||
        lastProviderState === 'processing' ||
        (!lastProviderStatus && Boolean(order.provider_order_id)) ||
        (providerName.toLowerCase().includes('grandtech') && !order.provider_order_id)
      );
      if (order.status === 'successful' && !isStaleSuccessful && !orderReference) continue;
      let providerOrderId = String(
        order.provider_order_id || existingResp.orderId || existingResp.provider_order_id ||
        existingResp.order_id || existingResp.providerReference || '',
      );
      if (!providerOrderId && providerName.toLowerCase().includes('grandtech')) {
        providerOrderId = recoverGrandTechOrderIdFromStored(existingResp, {
          phone: String(order.phone || ''),
          network: String(order.network_type || ''),
          volumeMb: Number(order.volume_mb || 0),
          createdAt: String(order.created_at || ''),
        }) || '';
        if (!providerOrderId) {
          providerOrderId = await recoverGrandTechOrderIdFromProvider({
            phone: String(order.phone || ''),
            network: String(order.network_type || ''),
            volumeMb: Number(order.volume_mb || 0),
            createdAt: String(order.created_at || ''),
          }) || '';
        }
      }
      const ref = String(order.provider_reference || '');

      const live = (providerOrderId || ref)
        ? await fetchDataOrderStatus(providerName as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
          console.error('Data status check failed:', err);
          return null;
        })
        : null;

      if (live && (live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled')) {
        // A previous false-success must be reopened before the terminal RPC can
        // safely apply the provider's real result and, when necessary, refund.
        if (order.status === 'successful' && live.state !== 'successful') {
          await supabase.from('agent_data_orders').update({
            status: 'processing',
            completed_at: null,
          }).eq('id', order.id).eq('status', 'successful');
        }
        await supabase.from('agent_data_orders').update({
          provider_order_id: order.provider_order_id || live.providerOrderId || null,
          provider_status: live.status,
          provider_state: live.state,
          last_status_checked_at: new Date().toISOString(),
          provider_response: {
            ...existingResp,
            lastProviderStatus: live.status,
            lastProviderState: live.state,
            checkedAt: new Date().toISOString(),
          },
        }).eq('id', order.id);
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: live.state,
          p_provider_response: { ...existingResp, lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Settle failed:', settleError);
        else {
          changed += 1;
          await recordStatusEvent(supabase, {
            orderType: 'agent_data_orders',
            orderId: String(order.id),
            agentId: user.id,
            provider: providerName,
            providerStatus: live.status,
            internalStatus: live.state,
            payload: live.payload,
          });
        }
        continue;
      }

      // If live answer is still processing or unavailable, update provider_response with check timestamp
      // DO NOT auto-refund or mark failed without provider confirmation.
      if (live?.status) {
        const nextStatus = live.state === 'processing' && order.status === 'successful'
          ? 'processing'
          : String(order.status || 'processing');
        await supabase
          .from('agent_data_orders')
          .update({
            status: nextStatus,
            completed_at: nextStatus === 'processing' ? null : order.completed_at,
            provider_order_id: order.provider_order_id || live.providerOrderId || null,
            provider_status: live.status,
            provider_state: live.state,
            last_status_checked_at: new Date().toISOString(),
            provider_response: { ...existingResp, lastProviderStatus: live.status, lastProviderState: live.state, checkedAt: new Date().toISOString() },
          })
          .eq('id', order.id);
        await recordStatusEvent(supabase, {
          orderType: 'agent_data_orders',
          orderId: String(order.id),
          agentId: user.id,
          provider: providerName,
          providerStatus: live.status,
          internalStatus: String(order.status || 'processing'),
          payload: live.payload,
        });
      }
    }

    // Public-data rows are legacy Standard Data orders and use the same
    // Swift/GrandTech status facade as the agent dashboard.
    changed += await syncLegacyPublicDataOrders(supabase, user.id, orderReference);

    // Wallet-page Standard Data purchases live in store_orders. They use the
    // same provider status facade, but their wallet debit/refund is tracked on
    // the store order itself rather than through settle_agent_data_order.
    changed += await syncStoreDataOrders(supabase, user.id, orderReference);

    const { data: fresh } = await supabase
      .from('agent_data_orders')
      .select('id, provider_reference, short_code, provider_order_id, network_type, volume_mb, amount, status, created_at, completed_at')
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (changed > 0) {
      try {
        await admin.rpc('log_activity', {
          p_summary: `Reconciled ${changed} data bundle order${changed === 1 ? '' : 's'} with provider`,
          p_meta: { changed },
          p_actor_user_id: user.id,
        });
      } catch (err) {
        console.error('Activity log write failed:', err);
      }
    }

    const { data: freshStoreOrders } = await supabase
      .from('store_orders')
      .select('id, reference, short_code, network, product_label, platform_price, provider, provider_reference, provider_response, fulfilment_status, payment_status, created_at, completed_at')
      .eq('agent_id', user.id)
      .eq('product_type', 'data_bundle')
      .order('created_at', { ascending: false })
      .limit(1000);

    return json({ success: true, changed, orders: fresh ?? [], storeOrders: freshStoreOrders ?? [] });
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

async function syncStoreDataOrders(
  supabase: ReturnType<typeof adminClient>,
  agentId: string,
  orderReference: string | null,
): Promise<number> {
  let query = supabase
    .from('store_orders')
    .select('id, reference, short_code, agent_id, network, product_ref, product_label, platform_price, refund_amount, wallet_debited, payment_status, fulfilment_status, commission_credited, meta, provider, provider_reference, provider_response, created_at')
    .eq('agent_id', agentId)
    .eq('product_type', 'data_bundle')
    .in('fulfilment_status', ['pending', 'processing', 'successful'])
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SYNC);

  if (orderReference) query = query.eq('reference', orderReference);

  const { data: orders, error } = await query;
  if (error) {
    console.error('Wallet store order sync read failed:', error);
    return 0;
  }

  let changed = 0;

  for (const order of orders ?? []) {
    const isPublicStoreOrder = order.meta && typeof order.meta === 'object'
      && String((order.meta as Record<string, unknown>).source || '') === 'public_storefront';
    const stored = (order.provider_response && typeof order.provider_response === 'object')
      ? order.provider_response as Record<string, unknown>
      : {};
    const lastProviderStatus = String(stored.lastProviderStatus || stored.providerStatus || '').trim().toUpperCase();
    const staleSuccessful = order.fulfilment_status === 'successful' && (
      ['PENDING', 'PROCESSING', 'QUEUED', 'SUBMITTED', 'RECEIVED', 'ACCEPTED', 'INITIATED'].includes(lastProviderStatus) ||
      String(stored.lastProviderState || '').toLowerCase() === 'processing'
    );
    if (order.fulfilment_status === 'successful' && !staleSuccessful) {
      // A provider may have delivered successfully while the commission RPC
      // was temporarily unavailable. Keep successful but uncredited rows in
      // this reconciliation queue until the idempotent credit succeeds.
      if (isPublicStoreOrder && !order.commission_credited) {
        const { error: profitError } = await supabase.rpc('credit_store_order_profit', {
          p_order_id: order.id,
        });
        if (profitError) {
          console.error('Store profit retry failed:', profitError);
        } else {
          changed += 1;
        }
      }
      continue;
    }
    const provider = String(order.provider || stored.provider || activeDataProvider(order.network, Number(stored.volumeMb || 0)));
    let providerOrderId = String(
      order.provider_reference || stored.providerOrderId || stored.orderId || stored.providerReference || '',
    );
    if (!providerOrderId && provider.toLowerCase().includes('grandtech')) {
      providerOrderId = recoverGrandTechOrderIdFromStored(stored, {
        phone: String(order.recipient || ''),
        network: String(order.network || ''),
        volumeMb: Number(stored.volumeMb || volumeForBundleId(String(order.product_ref || ''))?.volumeInMB || 0),
        createdAt: String(order.created_at || ''),
      }) || '';
      if (!providerOrderId) {
        providerOrderId = await recoverGrandTechOrderIdFromProvider({
          phone: String(order.recipient || ''),
          network: String(order.network || ''),
          volumeMb: Number(stored.volumeMb || volumeForBundleId(String(order.product_ref || ''))?.volumeInMB || 0),
          createdAt: String(order.created_at || ''),
        }) || '';
      }
    }
    const reference = String(order.reference || '');

    const live = (providerOrderId || reference)
      ? await fetchDataOrderStatus(provider as 'grandtech' | 'swift', providerOrderId, reference).catch((err) => {
        console.error('Wallet store data status check failed:', err);
        return null;
      })
      : null;

    if (!live) continue;

    const checkedAt = new Date().toISOString();
    const updatedResponse = {
      ...stored,
      provider,
      lastProviderStatus: live.status,
      lastProviderState: live.state,
      checkedAt,
    };

    if (order.fulfilment_status === 'successful' && live.state !== 'successful') {
      await supabase.from('store_orders').update({
        fulfilment_status: 'processing',
        completed_at: null,
      }).eq('id', order.id).eq('fulfilment_status', 'successful');
    }

    if (live.state === 'successful') {
      const { error: updateError } = await supabase
        .from('store_orders')
        .update({
          fulfilment_status: 'successful',
          provider_status: live.status,
          provider_state: live.state,
          last_status_checked_at: checkedAt,
          provider_response: updatedResponse,
          failure_reason: null,
          completed_at: checkedAt,
          updated_at: checkedAt,
        })
        .eq('id', order.id)
        .in('fulfilment_status', ['pending', 'processing']);
      if (updateError) console.error('Wallet store success update failed:', updateError);
      else {
        changed += 1;
        if (isPublicStoreOrder) {
          const { error: profitError } = await supabase.rpc('credit_store_order_profit', {
            p_order_id: order.id,
          });
          if (profitError) console.error('Store profit credit failed during reconciliation:', profitError);
        }
        await recordStatusEvent(supabase, {
          orderType: 'store_orders',
          orderId: String(order.id),
          agentId,
          provider,
          providerStatus: live.status,
          internalStatus: 'successful',
          payload: live.payload,
        });
      }
      continue;
    }

    if (live.state === 'failed' || live.state === 'cancelled') {
      const debitAmount = Number(order.platform_price || 0);
      let refundAmount = Number(order.refund_amount || 0);
      let paymentStatus = String(order.payment_status || 'paid');
      let refundMessage = '';

      if (order.wallet_debited && paymentStatus !== 'refunded' && refundAmount <= 0 && debitAmount > 0) {
        try {
          await refundWallet(
            agentId,
            reference,
            debitAmount,
            `Refund for failed store data order ${reference}`,
          );
          refundAmount = debitAmount;
          paymentStatus = 'refunded';
        } catch (refundError) {
          refundMessage = refundError instanceof Error ? refundError.message : String(refundError);
          console.error('Wallet store data refund failed:', refundError);
        }
      }

      const { error: updateError } = await supabase
        .from('store_orders')
        .update({
          payment_status: paymentStatus,
          fulfilment_status: 'failed',
          refund_amount: refundAmount,
          provider_status: live.status,
          provider_state: live.state,
          last_status_checked_at: checkedAt,
          provider_response: updatedResponse,
          failure_reason: refundMessage || `Provider ${live.state}: ${live.status}`,
          completed_at: checkedAt,
          updated_at: checkedAt,
        })
        .eq('id', order.id)
        .in('fulfilment_status', ['pending', 'processing']);
      if (updateError) console.error('Wallet store failure update failed:', updateError);
      else {
        changed += 1;
        await recordStatusEvent(supabase, {
          orderType: 'store_orders',
          orderId: String(order.id),
          agentId,
          provider,
          providerStatus: live.status,
          internalStatus: 'failed',
          payload: live.payload,
        });
      }
      continue;
    }

    await supabase
      .from('store_orders')
      .update({
        fulfilment_status: order.fulfilment_status === 'successful' && live.state === 'processing' ? 'processing' : order.fulfilment_status,
        provider_reference: order.provider_reference || live.providerOrderId || null,
        provider_status: live.status,
        provider_state: live.state,
        last_status_checked_at: checkedAt,
        provider_response: updatedResponse,
        updated_at: checkedAt,
      })
      .eq('id', order.id)
      .in('fulfilment_status', ['pending', 'processing', 'successful']);
    changed += 1;
    await recordStatusEvent(supabase, {
      orderType: 'store_orders',
      orderId: String(order.id),
      agentId,
      provider,
      providerStatus: live.status,
      internalStatus: String(order.fulfilment_status || 'processing'),
      payload: live.payload,
    });
  }

  return changed;
}

/**
 */
async function syncLegacyPublicDataOrders(
  supabase: ReturnType<typeof adminClient>,
  agentId: string,
  orderReference: string | null,
): Promise<number> {
  let query = supabase
    .from('public_data_orders')
    .select('id, payment_reference, provider_name, provider_reference, agent_id, customer_phone, network_type, volume_mb, sale_amount, status, created_at, provider_response')
    .eq('agent_id', agentId)
    .in('status', ['pending_payment', 'processing', 'successful'])
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SYNC);

  if (orderReference) query = query.eq('payment_reference', orderReference);

  const { data: orders, error } = await query;
  if (error) {
    console.error('Standard data sync read failed:', error);
    return 0;
  }

  let changed = 0;

  for (const order of orders ?? []) {
    const stored = (order.provider_response || {}) as Record<string, unknown>;
    const lastProviderStatus = String(stored.lastProviderStatus || stored.providerStatus || '').trim().toUpperCase();
    const staleSuccessful = order.status === 'successful' && (
      ['PENDING', 'PROCESSING', 'QUEUED', 'SUBMITTED', 'RECEIVED', 'ACCEPTED', 'INITIATED'].includes(lastProviderStatus) ||
      String(stored.lastProviderState || '').toLowerCase() === 'processing'
    );
    if (order.status === 'successful' && !staleSuccessful && !orderReference) continue;
    const provider = String(order.provider_name || stored.provider || activeDataProvider(order.network_type, Number(order.volume_mb)));
    let providerOrderId = String(order.provider_reference ?? stored.providerOrderId ?? stored.orderId ?? stored.providerReference ?? '');
    if (!providerOrderId && provider.toLowerCase().includes('grandtech')) {
      providerOrderId = recoverGrandTechOrderIdFromStored(stored, {
        phone: String(order.customer_phone || ''),
        network: String(order.network_type || ''),
        volumeMb: Number(order.volume_mb || 0),
        createdAt: String(order.created_at || ''),
      }) || '';
      if (!providerOrderId) {
        providerOrderId = await recoverGrandTechOrderIdFromProvider({
          phone: String(order.customer_phone || ''),
          network: String(order.network_type || ''),
          volumeMb: Number(order.volume_mb || 0),
          createdAt: String(order.created_at || ''),
        }) || '';
      }
    }
    const ref = String(order.payment_reference ?? '');

    const live = (providerOrderId || ref)
      ? await fetchDataOrderStatus(provider as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
        console.error('Standard data status check failed:', err);
        return null;
      })
      : null;

    let nextStatus: 'successful' | 'failed' | 'cancelled' | null = null;

    if (live?.state === 'successful') {
      nextStatus = 'successful';
    } else if (live?.state === 'failed' || live?.state === 'cancelled') {
      nextStatus = 'failed';
    }

    if (live?.state === 'processing' && order.status === 'successful') {
      await supabase.from('public_data_orders').update({
        status: 'processing',
        completed_at: null,
        provider_status: live.status,
        provider_state: live.state,
        last_status_checked_at: new Date().toISOString(),
        provider_response: { ...stored, lastProviderStatus: live.status, lastProviderState: live.state, checkedAt: new Date().toISOString() },
      }).eq('id', order.id).eq('status', 'successful');
    }

    if (live?.state && live.state !== 'processing') {
      await supabase.from('public_data_orders').update({
        provider_reference: order.provider_reference || live.providerOrderId || null,
        provider_status: live.status,
        provider_state: live.state,
        last_status_checked_at: new Date().toISOString(),
      }).eq('id', order.id);
    }

    // If provider confirmed terminal state
    if (nextStatus) {
      if (order.status === 'successful') {
        await supabase.from('public_data_orders').update({ status: 'processing', completed_at: null }).eq('id', order.id).eq('status', 'successful');
      }
      const { error: settleError } = await supabase.rpc('mark_public_data_order', {
        p_order_id: order.id,
        p_status: nextStatus,
        p_provider_amount: null,
        p_provider_reference: order.provider_reference || live?.providerOrderId || null,
        p_provider_response: { ...stored, lastProviderStatus: live?.status, lastProviderState: live?.state, checkedAt: new Date().toISOString() },
      });
      if (settleError) {
        console.error('Standard data settle failed:', settleError);
        continue;
      }
      changed += 1;

      await recordStatusEvent(supabase, {
        orderType: 'public_data_orders',
        orderId: String(order.id),
        agentId,
        provider,
        providerStatus: live?.status || nextStatus,
        internalStatus: nextStatus,
        payload: live?.payload,
      });

      // Only refund if provider explicitly failed
      if (nextStatus === 'failed' && order.agent_id) {
        await refundWallet(
          order.agent_id,
          String(order.payment_reference),
          Number(order.sale_amount),
          `Standard data bundle rejected by provider: ${live?.status || 'Failed'}`,
        ).catch((err) => console.error('Standard data refund failed:', err));
      }
    } else if (live?.status) {
      // Still in progress: update provider_response timestamp
      await supabase
        .from('public_data_orders')
        .update({
          provider_reference: order.provider_reference || live.providerOrderId || null,
          provider_status: live.status,
          provider_state: live.state,
          last_status_checked_at: new Date().toISOString(),
          provider_response: { ...stored, lastProviderStatus: live.status, lastProviderState: live.state, checkedAt: new Date().toISOString() },
        })
        .eq('id', order.id);
    }
  }

  return changed;
}
