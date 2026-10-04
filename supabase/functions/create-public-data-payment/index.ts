import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import {
  resolveAgentBundlePrice,
  type AgentPricingLike,
} from '../_shared/pricing.ts';
import {
  DATA_NETWORKS,
  catalogPrice,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';

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

  let reference = '';
  let orderId: string | null = null;

  try {
    const body = await request.json();
    const customerName = String(body.name || '').trim();
    const customerEmail = String(body.email || '').trim().toLowerCase();
    const customerPhone = String(body.phone || '').trim();
    const requestedBundleId = String(body.bundleId || '').trim().toLowerCase();

    if (!customerName || customerName.length > 120 ||
      !/^\S+@\S+\.\S+$/.test(customerEmail) || !/^0\d{9}$/.test(customerPhone)) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    // WALLET-FIRST: instant data is paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    let networkType = '';
    let volumeInMB = 0;
    let salePrice: number | null = null;

    if (requestedBundleId) {
      // Preferred path: the client picked a bundle_id from the catalog, so the
      // network, volume and price are read from the row it came from. The
      // storefront can never make us charge a price or size it chose itself.
      const { data: bundle, error: bundleError } = await admin
        .from('bundle_catalog')
        .select('bundle_id, network, volume_mb, price')
        .eq('bundle_id', requestedBundleId)
        .eq('active', true)
        .maybeSingle();

      if (bundleError) {
        console.error('bundle_catalog lookup failed:', bundleError);
        return json({ error: 'Unable to confirm the selected package. Please try again.' }, 502);
      }
      if (!bundle) {
        return json({ error: 'That package is no longer available. Please choose another one.' }, 400);
      }

      networkType = String(bundle.network);
      volumeInMB = Number(bundle.volume_mb);
      salePrice = Number(bundle.price);
    } else {
      // Legacy path for the pages that still post a network and a volume.
      networkType = String(body.networkType || '').trim().toLowerCase();
      volumeInMB = Number(body.volumeInMB);
      salePrice = catalogPrice(networkType, volumeInMB);
    }

    if (!DATA_NETWORKS.includes(networkType as DataNetwork) ||
      !Number.isInteger(volumeInMB) || volumeInMB <= 0 ||
      salePrice === null || !Number.isFinite(salePrice) || salePrice <= 0) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    const listPrice: number = salePrice;

    // The pricing helper only reads one row, but TypeScript cannot expand the
    // real client's generics that far and reports the type instantiation as
    // infinitely deep. Narrow it to the structural type the helper declares.
    const pricingClient = admin as unknown as AgentPricingLike;

    // The agent's own price from the Store > Pricing tab wins over the catalog,
    // so editing a price there actually changes what customers are charged.
    const saleAmount = await resolveAgentBundlePrice(
      pricingClient, agentId, networkType, volumeInMB, listPrice,
    );
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    reference = `PUB-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(agentId, reference, saleAmount, 'Instant data purchase', {
      service: 'instant_data',
      network_type: networkType,
      volume_mb: volumeInMB,
    });

    const { data: order, error: orderError } = await admin.from('public_data_orders').insert({
      payment_reference: reference, customer_name: customerName, customer_email: customerEmail,
      customer_phone: customerPhone, network_type: networkType, volume_mb: volumeInMB,
      sale_amount: saleAmount, status: 'pending_payment', agent_id: agentId,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID');
    if (!companyAgentId) throw new Error('Public data provider funding is not configured.');

    const dataPackage = await resolveDataPackage(networkType, volumeInMB);
    if (!dataPackage) throw new Error('Unable to confirm the provider bundle price.');
    const providerCost = dataPackage.costGhs;
    if (!Number.isFinite(providerCost) || providerCost <= 0) throw new Error('Unable to confirm the provider bundle price.');

    const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
    const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: companyAgentId, p_reference: providerReference, p_network_type: networkType,
      p_phone: customerPhone, p_volume_mb: volumeInMB, p_amount: Math.round(providerCost * 100) / 100,
    });
    if (reserveError) throw reserveError;

    const dispatch = await buyDataPackage(dataPackage, networkType, customerPhone);
    await admin.rpc('complete_agent_data_order', {
      p_order_id: providerOrderId, p_success: dispatch.success, p_provider_response: dispatch.payload,
    });
    // The provider accepting the order is not delivery: GrandTechHub fulfils
    // asynchronously and can leave an order PENDING/PROCESSING indefinitely.
    // Stay in 'processing' and let get-public-data-order reconcile, so a dropped
    // order is refunded instead of being reported as delivered.
    await admin.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: dispatch.success ? 'processing' : 'failed',
      p_provider_amount: providerCost,
      p_provider_reference: providerReference,
      p_provider_response: { ...dispatch.payload, provider: dataPackage.provider, providerOrderId: dispatch.orderId ?? null },
    });

    if (!dispatch.success) {
      const refundedBalance = await refundWallet(agentId, reference, saleAmount, 'Instant data provider failed');
      return json({
        success: false,
        refunded: true,
        walletBalance: refundedBalance,
        orderReference: reference,
        message: `Bundle delivery failed: ${dispatch.failureReason || 'The provider did not accept the order.'} Your wallet has been refunded.`,
      }, 502);
    }

    return json({
      success: true,
      walletBalance,
      orderReference: reference,
      status: 'processing',
      message: `Your ${Math.round(volumeInMB / 1024)}GB bundle order was accepted and is being delivered to ${customerPhone}.`,
    });
  } catch (error) {
    console.error('Public data payment error:', error);
    if (orderId && reference) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('public_data_orders')
          .select('sale_amount, status, agent_id')
          .eq('id', orderId)
          .maybeSingle();
        if (order && !['successful'].includes(order.status)) {
          const saleAmount = Number(order.sale_amount);
          const buyerAgentId = order.agent_id ?? '';
          if (buyerAgentId && saleAmount > 0) {
            await refundWallet(buyerAgentId, reference, saleAmount, 'Instant data purchase failed').catch(() => {});
          }
          await admin.rpc('mark_public_data_order', {
            p_order_id: orderId, p_status: 'failed', p_provider_amount: null,
            p_provider_reference: null, p_provider_response: { error: errorMessage(error, 'Unexpected error') },
          });
        }
      } catch (innerError) {
        console.error('Instant data refund/rollback failed:', innerError);
      }
    }
    const msg = errorMessage(error, 'Unable to complete data purchase.');
    const status = /authentication is required|session is invalid/i.test(msg)
      ? 401
      : /agent account required/i.test(msg)
      ? 403
      : msg.toLowerCase().includes('insufficient')
      ? 400
      : 500;
    return json({ error: msg, insufficientFunds: msg.toLowerCase().includes('insufficient') || undefined }, status);
  }
});