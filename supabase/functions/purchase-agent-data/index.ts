import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buySwiftPackage, resolveSwiftPackage } from '../_shared/swiftProvider.ts';

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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let orderId: string | null = null;
  let providerAccepted = false;
  try {
    const { admin, user } = await requireAgent(request);

    const body = await request.json();
    const phone = String(body.phone ?? '').trim();
    const networkType = String(body.networkType ?? '').trim().toLowerCase();
    const volumeInMB = Number(body.volumeInMB);

    if (!/^0\d{9}$/.test(phone)) return json({ error: 'Enter a valid 10-digit Ghanaian phone number.' }, 400);
    if (!NETWORKS.has(networkType)) return json({ error: 'Unsupported network.' }, 400);
    if (!Number.isInteger(volumeInMB) || volumeInMB <= 0 || volumeInMB > 204800) return json({ error: 'Invalid bundle volume.' }, 400);
    const saleAmount = catalog[networkType]?.[volumeInMB];
    if (!saleAmount) return json({ error: 'This bundle is not available at the current agent price.' }, 400);

    let providerCost: number;
    let swiftPackage;
    try {
      swiftPackage = await resolveSwiftPackage(networkType, volumeInMB);
    } catch (error) {
      return json({ error: errorMessage(error, 'Unable to confirm the current bundle price.') }, 502);
    }
    if (!swiftPackage) return json({ error: 'Unable to confirm the current bundle price.' }, 502);
    providerCost = Number(swiftPackage.price);
    if (!Number.isFinite(providerCost) || providerCost <= 0) {
      return json({ error: 'Unable to confirm the current bundle price.' }, 502);
    }

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

    const dispatch = await buySwiftPackage(swiftPackage.id, phone);
    const success = dispatch.success;
    providerAccepted = success;
    const { error: completeError } = await admin.rpc('complete_agent_data_order', {
      p_order_id: orderId,
      p_success: success,
      p_provider_response: dispatch.payload,
    });
    if (completeError) throw completeError;

    if (!success) return json({ error: dispatch.failureReason || 'The bundle provider did not accept the order.', orderReference: reference }, 502);
    return json({ success: true, orderReference: reference, providerReference: dispatch.orderId, status: dispatch.status || 'successful', amount: saleAmount });
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
    const msg = errorMessage(error, 'Unable to complete data purchase.');
    const status = msg.includes('Authentication') ? 401 : msg.includes('Verified agent') ? 403 : 500;
    return json({ error: msg }, status);
  }
});
