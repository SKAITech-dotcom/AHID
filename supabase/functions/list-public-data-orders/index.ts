import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';
import { fetchHubtelCommissionStatus } from '../_shared/hubtelCommissionStatus.ts';
import { settleHubtelAirtimeOrder } from '../_shared/hubtelSettlement.ts';

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

function airtimeStatusLabel(paymentStatus: unknown, airtimeStatus: unknown): string {
  const payment = String(paymentStatus || '').trim().toLowerCase();
  const status = String(airtimeStatus || '').trim().toLowerCase();
  if (status === 'delivered' || status === 'successful' || status === 'completed') return 'Successful';
  if (status === 'failed' || payment === 'failed') return 'Failed';
  if (payment === 'pending_payment') return 'Awaiting Payment';
  return 'Processing';
}

function normalizePhoneVariants(value: unknown): string[] {
  const raw = String(value ?? '').trim().replace(/[\s()-]/g, '');
  if (/^0\d{9}$/.test(raw)) return [raw, `+233${raw.slice(1)}`];
  if (/^\+233\d{9}$/.test(raw)) return [`0${raw.slice(4)}`, raw];
  if (/^233\d{9}$/.test(raw)) return [`0${raw.slice(3)}`, `+${raw}`];
  return [];
}

async function reconcileGuestAirtime(admin: ReturnType<typeof adminClient>, row: Record<string, unknown>) {
  const reference = String(row.payment_reference || '').trim();
  const baseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  const needsPaymentCheck = String(row.payment_status) === 'pending_payment'
    || (String(row.payment_status) === 'paid' && String(row.airtime_status) === 'pending');

  if (needsPaymentCheck && baseUrl && reference) {
    try {
      await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/verify-public-airtime-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const { data: refreshed } = await admin.from('airtime_orders')
        .select('id, payment_reference, short_code, recipient_phone, network, amount, payment_status, airtime_status, provider_reference, provider_response, created_at')
        .eq('id', row.id)
        .maybeSingle();
      if (refreshed) row = refreshed as Record<string, unknown>;
    } catch (error) {
      console.warn('Guest airtime payment check failed:', { reference, error: String(error) });
    }
  }

  if (String(row.payment_status) === 'paid'
    && ['processing', 'pending_provider'].includes(String(row.airtime_status))
    && reference) {
    const live = await fetchHubtelCommissionStatus(reference).catch(() => null);
    if (live && live.state !== 'pending') {
      try {
        await settleHubtelAirtimeOrder(admin, {
          id: String(row.id),
          agent_id: null,
          payment_reference: reference,
          amount: Number(row.amount),
          wallet_charge_amount: Number(row.amount),
          provider_reference: row.provider_reference ? String(row.provider_reference) : null,
        }, {
          state: live.state,
          payload: live.payload,
          providerReference: live.orderId ?? null,
        });
        const { data: refreshed } = await admin.from('airtime_orders')
          .select('id, payment_reference, short_code, recipient_phone, network, amount, payment_status, airtime_status, provider_reference, provider_response, created_at')
          .eq('id', row.id)
          .maybeSingle();
        if (refreshed) row = refreshed as Record<string, unknown>;
      } catch (error) {
        console.warn('Guest airtime delivery settlement failed:', { reference, error: String(error) });
      }
    }
  }
  return row;
}

/** Lists a guest customer's public-checkout and agent-store orders by phone. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const phoneVariants = normalizePhoneVariants(body.phone);
    if (!phoneVariants.length) {
      return json({ error: 'Enter a valid 10-digit Ghana recipient phone number.' }, 400);
    }
    const phone = phoneVariants[0];

    const admin = adminClient();
    const [
      { data: rows, error },
      { data: airtimeRows, error: airtimeError },
      { data: storeCandidates, error: storeError },
    ] = await Promise.all([
      admin
        .from('public_data_orders')
        .select('id, short_code, customer_phone, network_type, volume_mb, sale_amount, status, provider_name, provider_reference, provider_response, created_at')
        .is('agent_id', null)
        .in('customer_phone', phoneVariants)
        .order('created_at', { ascending: false })
        .limit(50),
      admin
        .from('airtime_orders')
        .select('id, payment_reference, short_code, recipient_phone, network, amount, payment_status, airtime_status, provider_reference, provider_response, created_at')
        .is('agent_id', null)
        .in('recipient_phone', phoneVariants)
        .order('created_at', { ascending: false })
        .limit(50),
      // Storefront customers do not have an agent session, but the durable
      // store order belongs to the store owner. Read the small data-bundle
      // candidate set and match the recipient/customer phone below so store
      // purchases appear in the same guest tracker.
      admin
        .from('store_orders')
        .select('id, short_code, reference, product_type, product_label, network, recipient, customer_phone, sale_amount, payment_status, fulfilment_status, provider, provider_reference, provider_response, meta, created_at')
        .eq('product_type', 'data_bundle')
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    if (error) throw error;
    if (airtimeError) throw airtimeError;
    if (storeError) throw storeError;

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

    for (const row of (storeCandidates || []).filter((candidate) => {
      const customerPhone = normalizePhoneVariants(candidate.customer_phone);
      const recipientPhone = normalizePhoneVariants(candidate.recipient);
      return customerPhone.includes(phone) || recipientPhone.includes(phone);
    })) {
      const stored = asRecord(row.provider_response);
      const paymentStatus = String(row.payment_status || 'pending').toLowerCase();
      const fulfilmentStatus = String(row.fulfilment_status || 'pending').toLowerCase();
      const providerValue = String(row.provider || stored.provider || '').trim().toLowerCase();
      const provider = providerValue.includes('grandtech')
        ? 'grandtech'
        : providerValue.includes('swift')
          ? 'swift'
          : providerValue;
      const providerOrderId = String(
        row.provider_reference
          || stored.providerOrderId
          || stored.orderId
          || stored.providerReference
          || '',
      ).trim();
      let status = paymentStatus !== 'paid' && fulfilmentStatus === 'pending'
        ? 'pending_payment'
        : fulfilmentStatus;
      let providerStatus = String(stored.lastProviderStatus || stored.providerStatus || fulfilmentStatus);

      if (status === 'processing' && providerOrderId && (provider === 'swift' || provider === 'grandtech')) {
        const live = await fetchDataOrderStatus(
          provider as 'swift' | 'grandtech',
          providerOrderId,
          String(row.reference || ''),
        ).catch(() => null);
        if (live) {
          providerStatus = live.status || providerStatus;
          if (['successful', 'failed', 'cancelled'].includes(live.state)) status = live.state;
          await admin.from('store_orders').update({
            provider_reference: live.providerOrderId || providerOrderId,
            provider_status: providerStatus,
            provider_state: live.state,
            last_status_checked_at: new Date().toISOString(),
            provider_response: {
              ...stored,
              lastProviderStatus: providerStatus,
              lastProviderState: live.state,
              lastStatusCheckedAt: new Date().toISOString(),
            },
          }).eq('id', row.id);
        }
      }

      const meta = asRecord(row.meta);
      orders.push({
        type: 'data',
        orderCode: row.short_code,
        recipientPhone: row.customer_phone || row.recipient,
        network: row.network,
        volumeMb: Number(meta.volume_mb || 0),
        amount: Number(row.sale_amount || 0),
        status,
        statusLabel: statusLabel(status),
        providerStatus,
        createdAt: row.created_at,
      });
    }

    for (const originalRow of airtimeRows || []) {
      const row = await reconcileGuestAirtime(admin, originalRow as Record<string, unknown>);
      const stored = asRecord(row.provider_response);
      const paymentStatus = String(row.payment_status || 'pending_payment').toLowerCase();
      const airtimeStatus = String(row.airtime_status || 'pending').toLowerCase();
      orders.push({
        type: 'airtime',
        orderCode: row.short_code,
        recipientPhone: row.recipient_phone,
        network: String(row.network || '').toUpperCase(),
        volumeMb: 0,
        amount: Number(row.amount || 0),
        status: airtimeStatus,
        statusLabel: airtimeStatusLabel(paymentStatus, airtimeStatus),
        providerStatus: String(stored.lastProviderStatus || stored.providerStatus || airtimeStatusLabel(paymentStatus, airtimeStatus)),
        paymentStatus,
        createdAt: row.created_at,
      });
    }

    orders.sort((a, b) => Date.parse(String(b.createdAt || '')) - Date.parse(String(a.createdAt || '')));

    return json({ success: true, orders });
  } catch (error) {
    console.error('list-public-data-orders failed:', error);
    return json({ error: error instanceof Error ? error.message : 'Unable to load your orders.' }, 500);
  }
});
