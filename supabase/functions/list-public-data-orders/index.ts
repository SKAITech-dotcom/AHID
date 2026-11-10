import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function statusLabel(status: unknown): string {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'successful') return 'Successful';
  if (value === 'failed') return 'Failed';
  if (value === 'cancelled') return 'Cancelled';
  if (value === 'pending_payment') return 'Awaiting Payment';
  if (value === 'processing') return 'Processing';
  return 'Pending';
}

/** Lists a guest customer's own public data orders by recipient phone. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const phone = String(body.phone || '').trim();
    if (!/^0\d{9}$/.test(phone)) {
      return json({ error: 'Enter a valid 10-digit Ghana recipient phone number.' }, 400);
    }

    const admin = adminClient();
    const { data: rows, error } = await admin
      .from('public_data_orders')
      .select('id, short_code, customer_phone, network_type, volume_mb, sale_amount, status, provider_name, provider_reference, provider_response, created_at')
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const orders = [];
    for (const row of rows || []) {
      const stored = asRecord(row.provider_response);
      const providerValue = String(row.provider_name || stored.provider || activeDataProvider(
        String(row.network_type || ''),
        Number(row.volume_mb || 0),
      )).trim().toLowerCase();
      const provider = providerValue.includes('grandtech')
        ? 'grandtech'
        : providerValue.includes('swift')
          ? 'swift'
          : providerValue;
      const providerOrderId = String(
        stored.providerOrderId
          || stored.orderId
          || row.provider_reference
          || stored.providerReference
          || '',
      ).trim();
      const providerReference = String(stored.providerReference || row.provider_reference || '').trim();
      let status = String(row.status || 'pending_payment').toLowerCase();
      let providerStatus = String(stored.lastProviderStatus || stored.providerStatus || status);

      if (['pending', 'processing'].includes(status) && providerOrderId && (provider === 'swift' || provider === 'grandtech')) {
        const live = await fetchDataOrderStatus(
          provider as 'swift' | 'grandtech',
          providerOrderId,
          providerReference,
        ).catch(() => null);
        if (live) {
          providerStatus = live.status || providerStatus;
          if (['successful', 'failed', 'cancelled'].includes(live.state)) status = live.state;
          await admin.from('public_data_orders').update({
            provider_response: {
              ...stored,
              lastProviderStatus: providerStatus,
              lastProviderState: live.state,
              lastStatusCheckedAt: new Date().toISOString(),
            },
          }).eq('id', row.id);
        }
      }

      orders.push({
        orderCode: row.short_code,
        recipientPhone: row.customer_phone,
        network: row.network_type,
        volumeMb: Number(row.volume_mb || 0),
        amount: Number(row.sale_amount || 0),
        status,
        statusLabel: statusLabel(status),
        providerStatus,
        createdAt: row.created_at,
      });
    }

    return json({ success: true, orders });
  } catch (error) {
    console.error('list-public-data-orders failed:', error);
    return json({ error: error instanceof Error ? error.message : 'Unable to load your orders.' }, 500);
  }
});
