import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

interface OrderMatch {
  trackingId: string;
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference } = await request.json();
    const ref = String(reference || '').trim().toUpperCase();
    if (!ref) return json({ error: 'Please enter a valid tracking ID.' }, 400);

    const admin = adminClient();
    let match: OrderMatch | null = null;

    // Public data bundles
    if (ref.startsWith('PUB-')) {
      const { data, error } = await admin
        .from('public_data_orders')
        .select('payment_reference, network_type, volume_mb, sale_amount, customer_name, customer_phone, customer_email, status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const packageLabel = `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`;
        match = {
          trackingId: data.payment_reference,
          type: 'data',
          network: clean(data.network_type).toUpperCase(),
          package: packageLabel,
          price: money(data.sale_amount),
          name: data.customer_name || 'Customer',
          phone: data.customer_phone || '',
          status: data.status === 'successful' ? 'Successful' : 'Processing',
          date: dateOf(data.created_at),
        };
      }
    }

    // Result checker orders
    if (ref.startsWith('RC-')) {
      const { data, error } = await admin
        .from('results_orders')
        .select('payment_reference, exam_type, quantity, amount, email, status, serial_pin, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
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
        .select('provider_reference, network_type, phone, volume_mb, amount, status, created_at')
        .eq('provider_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.provider_reference,
          type: 'data',
          network: (data.network_type || '').toUpperCase(),
          package: `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`,
          price: money(data.amount),
          name: 'Agent Order',
          phone: data.phone || '',
          status: data.status === 'successful' ? 'Successful' : 'Processing',
          date: dateOf(data.created_at),
        };
      }
    }

    // Utility bill orders
    if (ref.startsWith('UTIL-')) {
      const { data, error } = await admin
        .from('utility_orders')
        .select('payment_reference, bill_type, package_name, amount, customer_name, customer_phone, status, token_code, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
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
        .select('payment_reference, network, amount, customer_name, recipient_phone, payment_status, airtime_status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const status = data.airtime_status === 'delivered' ? 'Delivered'
          : data.airtime_status === 'failed' ? 'Failed'
          : data.payment_status === 'paid' ? 'Processing' : (data.payment_status || 'Pending');
        match = {
          trackingId: data.payment_reference,
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