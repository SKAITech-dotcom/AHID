import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

const NETWORKS = new Set(['mtn', 'telecel', 'airteltigo']);
const catalog: Record<string, Record<number, number>> = {
  mtn: {
    1024: 4.2, 2048: 8.3, 3072: 12.2, 4096: 16.2, 5120: 20.5,
    6144: 24.8, 8192: 34, 10240: 40, 15360: 58.6, 20480: 78,
    25600: 98, 30720: 118, 40960: 156, 51200: 195, 102400: 375,
  },
  telecel: {
    5120: 18.5, 10240: 35, 11264: 39, 15360: 52, 16384: 58,
    20480: 69, 22528: 79, 25600: 86, 27648: 98, 30720: 103,
    33792: 114, 40960: 137, 45056: 150, 51200: 171, 102400: 357,
    112640: 370,
  },
  airteltigo: {
    1024: 4, 2048: 8, 3072: 12, 4096: 16, 5120: 20, 6144: 24,
    7168: 28, 8192: 32, 9216: 36, 30720: 65, 40960: 75, 51200: 90,
    61440: 110, 71680: 125, 81920: 150, 102400: 175, 153600: 220,
    204800: 330,
  },
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

function providerSucceeded(payload: Record<string, unknown>) {
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  if (payload.success === true || payload.status === true || nestedData.status === true) return true;
  const status = String(payload.status ?? nestedData.status ?? '').toLowerCase();
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) return false;
  return ['success', 'successful', 'completed'].includes(status);
}

function providerAmount(payload: Record<string, unknown>) {
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  // RemaData's get-cost-price endpoint returns `api_price` at the top level.
  // Keep the other aliases for compatibility with provider response variants.
  const value = payload.api_price ?? payload.cost ?? payload.price ?? payload.amount ?? payload.costPrice
    ?? nestedData.api_price ?? nestedData.cost ?? nestedData.price ?? nestedData.amount ?? nestedData.costPrice;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let orderId: string | null = null;
  let providerAccepted = false;
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Please sign in before buying data.' }, 401);

    const body = await request.json();
    const phone = String(body.phone ?? '').trim();
    const networkType = String(body.networkType ?? '').trim().toLowerCase();
    const volumeInMB = Number(body.volumeInMB);

    if (!/^0\d{9}$/.test(phone)) return json({ error: 'Enter a valid 10-digit Ghanaian phone number.' }, 400);
    if (!NETWORKS.has(networkType)) return json({ error: 'Unsupported network.' }, 400);
    if (!Number.isInteger(volumeInMB) || volumeInMB <= 0 || volumeInMB > 204800) return json({ error: 'Invalid bundle volume.' }, 400);
    const saleAmount = catalog[networkType]?.[volumeInMB];
    if (!saleAmount) return json({ error: 'This bundle is not available at the current agent price.' }, 400);

    const admin = adminClient();
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return json({ error: 'Your session is invalid. Please sign in again.' }, 401);

    const apiKey = Deno.env.get('DATA_API_KEY');
    if (!apiKey) throw new Error('RemaData API is not configured.');

    const costResponse = await fetch('https://remadata.com/api/get-cost-price', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkType, volumeInMB }),
    });
    const costPayload = await costResponse.json().catch(() => ({}));
    const providerCost = providerAmount(costPayload);
    if (!costResponse.ok || providerCost === null) return json({ error: 'Unable to confirm the current bundle price.' }, 502);

    const reference = `DATA-${crypto.randomUUID()}`;
    const { data: reservedOrder, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: user.id,
      p_reference: reference,
      p_network_type: networkType,
      p_phone: phone,
      p_volume_mb: volumeInMB,
      p_amount: saleAmount,
    });
    if (reserveError) {
      if (reserveError.message.toLowerCase().includes('insufficient')) return json({ error: 'Insufficient wallet balance.' }, 400);
      throw reserveError;
    }
    orderId = reservedOrder;

    const response = await fetch('https://remadata.com/api/buy-data', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: reference, phone, volumeInMB, networkType }),
    });
    const providerPayload = await response.json().catch(() => ({ raw: 'Invalid provider response' }));
    const success = response.ok && providerSucceeded(providerPayload);
    providerAccepted = success;
    const { error: completeError } = await admin.rpc('complete_agent_data_order', {
      p_order_id: orderId,
      p_success: success,
      p_provider_response: providerPayload,
    });
    if (completeError) throw completeError;

    if (!success) return json({ error: 'The bundle provider did not accept the order.', orderReference: reference }, 502);
    return json({ success: true, orderReference: reference, status: 'successful', amount: saleAmount });
  } catch (error) {
    if (orderId && !providerAccepted) {
      try {
        await adminClient().rpc('complete_agent_data_order', {
          p_order_id: orderId,
          p_success: false,
          p_provider_response: { error: errorMessage(error, 'Unexpected error') },
        });
      } catch (refundError) {
        console.error('Failed to refund reserved order:', refundError);
      }
    }
    console.error(error);
    return json({ error: errorMessage(error, 'Unable to complete data purchase.') }, 500);
  }
});
