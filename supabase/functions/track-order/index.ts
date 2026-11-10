import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus, recoverGrandTechOrderIdFromProvider, recoverGrandTechOrderIdFromStored } from '../_shared/dataProvider.ts';

interface OrderMatch {
  trackingId: string;
  shortCode?: string;
  type: string;
  network: string;
  package: string;
  price: string;
  name: string;
  phone: string;
  status: string;
  date: string;
}

const clean = (value: unknown) => String(value ?? '');
const money = (value: unknown) => `GHS ${Number(value).toFixed(2)}`;
const dateOf = (value: unknown) => value ? new Date(String(value)).toLocaleString() : '';

/**
 * Data bundles settle asynchronously, so a tracking lookup has to describe every
 * state. Collapsing anything that is not 'successful' into "Processing" would
 * report a failed or refunded order as still on its way.
 */
function dataOrderLabel(status: unknown): string {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === 'successful') return 'Successful';
  if (value === 'failed') return 'Failed';
  if (value === 'cancelled') return 'Cancelled';
  if (value === 'pending_payment') return 'Awaiting Payment';
  if (value === 'processing') return 'Processing';
  return 'Pending';
}

async function liveDataStatus(admin: ReturnType<typeof adminClient>, row: Record<string, unknown>) {
  const current = String(row.status || '').toLowerCase();
  // A previous frontend could have marked an accepted order as completed
  // before the provider settled it. Re-check every non-failed order so the
  // customer sees the provider's current state instead of a stale local one.
  if (['failed', 'cancelled', 'refunded'].includes(current)) return null;
  const stored = row.provider_response && typeof row.provider_response === 'object'
    ? row.provider_response as Record<string, unknown>
    : {};
  const providerValue = String(row.provider_name || stored.provider || activeDataProvider(
    String(row.network_type || ''),
    Number(row.volume_mb || 0),
  )).trim().toLowerCase();
  const provider = providerValue.includes('grandtech')
    ? 'grandtech'
    : providerValue.includes('swift')
      ? 'swift'
      : providerValue;
  let providerOrderId = String(
    (row.order_table === 'public_data_orders' ? row.provider_reference : row.provider_order_id)
      || stored.providerOrderId
      || stored.orderId
      || (row.order_table === 'public_data_orders' ? row.provider_reference : '')
      || stored.providerReference
      || '',
  ).trim();
  if (!providerOrderId && provider === 'grandtech') {
    providerOrderId = recoverGrandTechOrderIdFromStored(stored, {
      phone: String(row.phone || row.customer_phone || ''),
      network: String(row.network_type || ''),
      volumeMb: Number(row.volume_mb || 0),
      createdAt: String(row.created_at || ''),
    }) || '';
    if (!providerOrderId) {
      providerOrderId = await recoverGrandTechOrderIdFromProvider({
        phone: String(row.phone || row.customer_phone || ''),
        network: String(row.network_type || ''),
        volumeMb: Number(row.volume_mb || 0),
        createdAt: String(row.created_at || ''),
      }) || '';
    }
  }
  const reference = String(row.provider_reference || '').trim();
  if (!providerOrderId && !reference) return null;
  if (provider !== 'swift' && provider !== 'grandtech') return null;

  const live = await fetchDataOrderStatus(
    provider as 'swift' | 'grandtech',
    providerOrderId,
    reference,
  ).catch(() => null);
  if (!live) return null;
  const checkedAt = new Date().toISOString();
  const providerIdentity = row.order_table === 'public_data_orders'
    ? (providerOrderId ? { provider_reference: providerOrderId } : {})
    : (providerOrderId ? { provider_order_id: providerOrderId } : {});
  await admin.from(row.order_table === 'public_data_orders' ? 'public_data_orders' : 'agent_data_orders')
    .update({
      provider_response: {
        ...stored,
        lastProviderStatus: live.status,
        lastProviderState: live.state,
        lastStatusCheckedAt: checkedAt,
      },
      provider_status: live.status,
      provider_state: live.state,
      last_status_checked_at: checkedAt,
      ...providerIdentity,
    })
    .eq('id', row.id);
  return live;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference } = await request.json();
    const raw = String(reference || '').trim();
    if (!raw) return json({ error: 'Please enter a valid tracking ID.' }, 400);
    // Customers quote the 5-character code, so accept it as well as the long
    // reference prefixes.
    const ref = raw.toUpperCase();
    const admin = adminClient();
    let match: OrderMatch | null = null;

    if (/^[A-Z0-9]{5}$/.test(ref)) {
      // 1. Check airtime orders
      const { data: airtimeData } = await admin
        .from('airtime_orders')
        .select('payment_reference, short_code, network, amount, customer_name, recipient_phone, payment_status, airtime_status, created_at')
        .eq('short_code', ref)
        .maybeSingle();
      if (airtimeData) {
        const status = airtimeData.airtime_status === 'delivered' ? 'Delivered'
          : airtimeData.airtime_status === 'failed' ? 'Failed'
          : airtimeData.payment_status === 'paid' ? 'Processing' : (airtimeData.payment_status || 'Pending');
        match = {
          trackingId: airtimeData.short_code,
          shortCode: airtimeData.short_code,
          type: 'airtime',
          network: (airtimeData.network || '').toUpperCase(),
          package: `Airtime (GHS ${Number(airtimeData.amount).toFixed(2)})`,
          price: money(airtimeData.amount),
          name: airtimeData.customer_name || 'Airtime',
          phone: airtimeData.recipient_phone || '',
          status,
          date: dateOf(airtimeData.created_at),
        };
      }

      // 2. Check agent data orders
      if (!match) {
        const { data: publicData, error } = await admin
          .from('public_data_orders')
          .select('id, payment_reference, short_code, provider_name, provider_reference, provider_response, network_type, volume_mb, customer_phone, sale_amount, status, created_at')
          .eq('short_code', ref)
          .maybeSingle();
        if (!error && publicData) {
          const live = await liveDataStatus(admin, { ...publicData, order_table: 'public_data_orders' });
          match = {
            trackingId: publicData.short_code,
            shortCode: publicData.short_code,
            type: 'data',
            network: (publicData.network_type || '').toUpperCase(),
            package: `${publicData.volume_mb >= 1024 ? `${(publicData.volume_mb / 1024)}GB` : `${publicData.volume_mb}MB`} ${clean(publicData.network_type).toUpperCase()}`,
            price: money(publicData.sale_amount),
            name: 'Customer',
            phone: publicData.customer_phone || '',
            status: live ? dataOrderLabel(live.state) : dataOrderLabel(publicData.status),
            date: dateOf(publicData.created_at),
          };
        }
      }

      // 3. Check agent data orders
      if (!match) {
        const { data, error } = await admin
          .from('agent_data_orders')
          .select('id, provider_reference, provider_name, provider_order_id, provider_response, short_code, network_type, phone, volume_mb, amount, status, created_at')
          .eq('short_code', ref)
          .maybeSingle();
        if (!error && data) {
          const live = await liveDataStatus(admin, { ...data, order_table: 'agent_data_orders' });
          match = {
            trackingId: data.provider_reference,
            shortCode: data.short_code,
            type: 'data',
            network: (data.network_type || '').toUpperCase(),
            package: `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`,
            price: money(data.amount),
            name: 'Agent Order',
            phone: data.phone || '',
            status: live ? dataOrderLabel(live.state) : dataOrderLabel(data.status),
            date: dateOf(data.created_at),
          };
        }
      }

      // 4. Check utility orders
      if (!match) {
        const { data: utilData } = await admin
          .from('utility_orders')
          .select('payment_reference, short_code, bill_type, package_name, amount, customer_name, customer_phone, status, token_code, created_at')
          .eq('short_code', ref)
          .maybeSingle();
        if (utilData) {
          match = {
            trackingId: utilData.short_code,
            shortCode: utilData.short_code,
            type: 'utility',
            network: (utilData.bill_type || '').replaceAll('_', ' ').toUpperCase(),
            package: utilData.package_name ? `Utility ${utilData.package_name}` : 'Utility Bill',
            price: money(utilData.amount),
            name: utilData.customer_name || 'Customer',
            phone: utilData.customer_phone || '',
            status: utilData.status === 'completed' ? 'Completed' : utilData.status,
            date: dateOf(utilData.created_at),
          };
        }
      }
    }

    // Public data bundles. New guest references start with PUB (without the
    // historical hyphen), so accept both formats.
    if (ref.startsWith('PUB')) {
      const { data, error } = await admin
        .from('public_data_orders')
        .select('id, payment_reference, short_code, provider_name, provider_reference, provider_response, network_type, volume_mb, sale_amount, customer_name, customer_phone, customer_email, status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const live = await liveDataStatus(admin, { ...data, order_table: 'public_data_orders' });
        const packageLabel = `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`;
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'data',
          network: clean(data.network_type).toUpperCase(),
          package: packageLabel,
          price: money(data.sale_amount),
          name: data.customer_name || 'Customer',
          phone: data.customer_phone || '',
          status: live ? dataOrderLabel(live.state) : dataOrderLabel(data.status),
          date: dateOf(data.created_at),
        };
      }
    }

    // Result checker orders
    if (ref.startsWith('RC-')) {
      const { data, error } = await admin
        .from('results_orders')
        .select('payment_reference, short_code, exam_type, quantity, amount, email, status, serial_pin, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'results',
          network: data.exam_type,
          package: `Results Checker x${data.quantity}`,
          price: money(data.amount),
          name: data.email,
          phone: '',
          status: data.status === 'paid' ? 'Completed' : data.status,
          date: dateOf(data.created_at),
        };
      }
    }

    // Agent data orders (agent dashboard tracking IDs)
    if (ref.startsWith('DATA-')) {
      const { data, error } = await admin
        .from('agent_data_orders')
        .select('id, provider_reference, provider_name, provider_order_id, provider_response, short_code, network_type, phone, volume_mb, amount, status, created_at')
        .eq('provider_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const live = await liveDataStatus(admin, { ...data, order_table: 'agent_data_orders' });
        match = {
          trackingId: data.provider_reference,
          shortCode: data.short_code,
          type: 'data',
          network: (data.network_type || '').toUpperCase(),
          package: `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`,
          price: money(data.amount),
          name: 'Agent Order',
          phone: data.phone || '',
          status: live ? dataOrderLabel(live.state) : dataOrderLabel(data.status),
          date: dateOf(data.created_at),
        };
      }
    }

    // Utility bill orders
    if (ref.startsWith('UTIL-')) {
      const { data, error } = await admin
        .from('utility_orders')
        .select('payment_reference, short_code, bill_type, package_name, amount, customer_name, customer_phone, status, token_code, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'utility',
          network: (data.bill_type || '').replaceAll('_', ' ').toUpperCase(),
          package: data.package_name ? `Utility ${data.package_name}` : 'Utility Bill',
          price: money(data.amount),
          name: data.customer_name || 'Customer',
          phone: data.customer_phone || '',
          status: data.status === 'completed' ? 'Completed' : data.status,
          date: dateOf(data.created_at),
        };
      }
    }

    // Airtime orders (public + agent)
    if (ref.startsWith('AIR-')) {
      const { data, error } = await admin
        .from('airtime_orders')
        .select('payment_reference, short_code, network, amount, customer_name, recipient_phone, payment_status, airtime_status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const status = data.airtime_status === 'delivered' ? 'Delivered'
          : data.airtime_status === 'failed' ? 'Failed'
          : data.payment_status === 'paid' ? 'Processing' : (data.payment_status || 'Pending');
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'airtime',
          network: (data.network || '').toUpperCase(),
          package: `Airtime (GHS ${Number(data.amount).toFixed(2)})`,
          price: money(data.amount),
          name: data.customer_name || 'Airtime',
          phone: data.recipient_phone || '',
          status,
          date: dateOf(data.created_at),
        };
      }
    }

    if (!match) {
      return json({ error: 'No order found matching this tracking ID.' }, 404);
    }
    return json({ order: match });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to track order.' }, 500);
  }
});
