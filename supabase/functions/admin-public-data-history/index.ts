import { adminClient, corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus, recoverGrandTechOrderIdFromProvider, recoverGrandTechOrderIdFromStored } from '../_shared/dataProvider.ts';

type OrderRow = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function providerOrderId(row: OrderRow, stored: Record<string, unknown>): string {
  return text(
    stored.providerOrderId
      ?? stored.orderId
      ?? stored.provider_order_id
      ?? row.provider_reference
      ?? stored.providerReference,
  );
}

function providerReference(row: OrderRow, stored: Record<string, unknown>): string {
  return text(stored.providerReference ?? row.provider_reference ?? stored.providerOrderId ?? stored.orderId);
}

function internalStatus(row: OrderRow): string {
  return text(row.status) || 'pending_payment';
}

function isOpen(status: string): boolean {
  return ['pending', 'processing'].includes(status.toLowerCase());
}

function needsProviderRefresh(status: string, stored: Record<string, unknown>): boolean {
  const providerStatus = text(stored.lastProviderStatus || stored.providerStatus).toUpperCase();
  return isOpen(status) || (status.toLowerCase() === 'successful' && (
    ['PENDING', 'PROCESSING', 'QUEUED', 'SUBMITTED', 'RECEIVED', 'ACCEPTED', 'INITIATED'].includes(providerStatus) ||
    text(stored.lastProviderState).toLowerCase() === 'processing'
  ));
}

/**
 * Admin-only view of guest data orders. Provider status is refreshed for open
 * orders, while provider identifiers remain in this protected response only.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST' && request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { admin } = await requireAdmin(request);
    const { data: rows, error } = await admin
      .from('public_data_orders')
      .select('id, short_code, customer_phone, network_type, volume_mb, sale_amount, payment_provider, status, provider_name, provider_reference, provider_response, created_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const orders: OrderRow[] = [];
    let liveChecks = 0;
    for (const raw of (rows || []) as OrderRow[]) {
      const row = raw;
      const stored = asRecord(row.provider_response);
      const provider = text(row.provider_name || stored.provider || activeDataProvider(
        text(row.network_type),
        Number(row.volume_mb || 0),
      )).toLowerCase();
      const orderId = providerOrderId(row, stored);
      const reference = providerReference(row, stored);
      const status = internalStatus(row);
      let providerStatus = text(stored.lastProviderStatus || stored.providerStatus) || status;
      let providerState = text(stored.lastProviderState);
      let checkedAt = text(stored.lastStatusCheckedAt) || null;

      // Keep one admin refresh bounded even if a large history contains many
      // open orders. The stored status remains visible for the rest.
      if (needsProviderRefresh(status, stored) && !orderId && provider === 'grandtech') {
        const recovered = recoverGrandTechOrderIdFromStored(stored, {
          phone: text(row.customer_phone),
          network: text(row.network_type),
          volumeMb: Number(row.volume_mb || 0),
          createdAt: text(row.created_at),
        });
        if (recovered) {
          stored.providerOrderId = recovered;
        }
        if (!stored.providerOrderId) {
          stored.providerOrderId = await recoverGrandTechOrderIdFromProvider({
            phone: text(row.customer_phone),
            network: text(row.network_type),
            volumeMb: Number(row.volume_mb || 0),
            createdAt: text(row.created_at),
          });
        }
      }
      const liveOrderId = provider === 'grandtech' && !orderId
        ? text(stored.providerOrderId)
        : orderId;
      if (needsProviderRefresh(status, stored) && liveOrderId && liveChecks < 80 && (provider === 'swift' || provider === 'grandtech')) {
        liveChecks += 1;
        try {
          const live = await fetchDataOrderStatus(provider as 'swift' | 'grandtech', liveOrderId, reference);
          if (live) {
            providerStatus = live.status || providerStatus;
            providerState = live.state;
            checkedAt = new Date().toISOString();
            const update: Record<string, unknown> = {
              provider_response: {
                ...stored,
                providerOrderId: live.providerOrderId || liveOrderId,
                lastProviderStatus: providerStatus,
                lastProviderState: providerState,
                lastStatusCheckedAt: checkedAt,
                livePayload: live.payload || null,
              },
            };
            if (live.providerOrderId) update.provider_reference = live.providerOrderId;
            if (status === 'successful' && live.state === 'processing') {
              update.status = 'processing';
              update.completed_at = null;
            }
            await admin.from('public_data_orders').update(update).eq('id', row.id);
            if (status === 'successful' && live.state === 'processing') status = 'processing';
          }
        } catch (statusError) {
          console.warn('Guest order provider status check failed:', row.id, statusError);
        }
      }

      orders.push({
        id: row.id,
        orderCode: text(row.short_code),
        recipientPhone: text(row.customer_phone),
        network: text(row.network_type),
        volumeMb: Number(row.volume_mb || 0),
        amount: Number(row.sale_amount || 0),
        paymentProvider: text(row.payment_provider),
        status,
        provider,
        providerOrderId: liveOrderId || null,
        providerReference: reference || null,
        providerStatus,
        providerState: providerState || null,
        checkedAt,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      });
    }

    return json({ success: true, orders });
  } catch (error) {
    console.error('admin-public-data-history failed:', error);
    const message = error instanceof Error ? error.message : 'Unable to load non-agent history.';
    const authFailure = /authentication|session is invalid|administrator access/i.test(message);
    return json({ error: message }, authFailure ? 401 : 500);
  }
});
