import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';

const VALID_NETWORKS = new Set(['mtn', 'telecel', 'at']);

function getCustomerCoveredGrossAmount(netAmount: number) {
  const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
  const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
  return Math.round(((netAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

async function findIdempotentOrder(admin: ReturnType<typeof adminClient>, key: string, agentId: string) {
  if (!key) return null;
  const { data } = await admin
    .from('airtime_orders')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (!data || data.agent_id !== agentId) return null;
  return data;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    const network = String(body.network ?? '').trim().toLowerCase();
    const phone = String(body.phone ?? '').trim();
    const paymentMethod = String(body.paymentMethod ?? 'paystack').trim().toLowerCase();
    const rawAmount = Number(body.amount);
    const customerName = String(body.customerName ?? body.name ?? '').trim();
    let customerEmail = String(body.customerEmail ?? body.email ?? '').trim().toLowerCase();
    const clientRequestId = String(body.clientRequestId ?? body.idempotencyKey ?? '').trim() || null;

    // Validation
    if (!VALID_NETWORKS.has(network)) {
      return json({ error: 'Invalid network selection. Choose MTN, Telecel, or AT.' }, 400);
    }

    if (!/^0[235]\d{8}$/.test(phone)) {
      return json({ error: 'Please enter a valid 10-digit Ghanaian phone number (e.g. 024XXXXXXX).' }, 400);
    }

    if (!Number.isFinite(rawAmount) || rawAmount < 1.00 || rawAmount > 500.00) {
      return json({ error: 'Airtime amount must be between GHS 1.00 and GHS 500.00.' }, 400);
    }

    const netAmount = Math.round(rawAmount * 100) / 100;

    // ---------------------------------------------------------------------
    // SECURITY: Airtime is an AGENTS-ONLY service. Both the wallet flow and
    // the Paystack flow require a verified, authenticated Agent session.
    // A value sent from the frontend is never trusted.
    // ---------------------------------------------------------------------
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;
    customerEmail = customerEmail || user.email || 'agent@skaitechgh.com';

    // -------------------------------------------------------------
    // FLOW A: AGENT WALLET PAYMENT
    // -------------------------------------------------------------
    if (paymentMethod === 'wallet') {
      if (clientRequestId) {
        const existing = await findIdempotentOrder(admin, clientRequestId, agentId);
        if (existing && existing.payment_method === 'wallet') {
          return json({
            success: true,
            idempotent: true,
            paymentMethod: 'wallet',
            reference: existing.payment_reference,
            amount: existing.amount,
            network: existing.network,
            phone: existing.recipient_phone,
            airtimeStatus: existing.airtime_status,
            message: 'This airtime purchase was already submitted. No duplicate charge was made.',
          });
        }
      }

      const reference = `AIR-${crypto.randomUUID()}`;

      // 1. Atomically deduct from wallet and create order marked as paid
      const { data: orderData, error: orderError } = await admin.rpc('purchase_agent_airtime', {
        p_agent_id: agentId,
        p_reference: reference,
        p_phone: phone,
        p_network: network,
        p_amount: netAmount,
        p_customer_name: customerName || user.user_metadata?.full_name || 'Agent',
        p_customer_email: customerEmail,
      });

      if (orderError) {
        console.error('Wallet deduction error:', orderError);
        return json({ error: orderError.message || 'Failed to process wallet payment.' }, 400);
      }

      if (clientRequestId) {
        await admin.from('airtime_orders').update({ idempotency_key: clientRequestId }).eq('id', orderData.id);
      }

      // 2. Dispatch airtime to provider (Hubtel)
      const dispatchResult = await dispatchAirtimeTopup({
        phone,
        network: network as 'mtn' | 'telecel' | 'at',
        amount: netAmount,
        reference,
      });

      // 3. Update order with fulfillment status
      await admin.rpc('fulfil_airtime_order', {
        p_order_id: orderData.id,
        p_airtime_status: dispatchResult.status,
        p_provider_reference: dispatchResult.providerReference ?? null,
        p_provider_response: dispatchResult.providerResponse ?? null,
        p_failure_reason: dispatchResult.failureReason ?? null,
      });

      return json({
        success: true,
        paymentMethod: 'wallet',
        reference,
        amount: netAmount,
        network,
        phone,
        airtimeStatus: dispatchResult.status,
        message: dispatchResult.status === 'delivered'
          ? 'Airtime top-up successful!'
          : dispatchResult.status === 'pending_provider'
          ? 'Payment processed. Airtime dispatch queued pending provider API credentials.'
          : `Airtime delivery failed: ${dispatchResult.failureReason || 'Provider declined'}`,
      });
    }

    // -------------------------------------------------------------
    // FLOW B: PAYSTACK CHECKOUT GATEWAY (MOMO & CARDS) — AGENTS ONLY
    // -------------------------------------------------------------
    if (!customerEmail || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
      customerEmail = `${phone}@customer.skaitechgh.com`;
    }

    const grossAmount = getCustomerCoveredGrossAmount(netAmount);
    const feeAmount = Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100;

    let reference: string;
    if (clientRequestId) {
      const existing = await findIdempotentOrder(admin, clientRequestId, agentId);
      if (existing && existing.payment_method === 'paystack') {
        if (existing.payment_status === 'paid' || existing.airtime_status === 'delivered') {
          return json({
            success: true,
            idempotent: true,
            reference: existing.payment_reference,
            amount: existing.amount,
            network: existing.network,
            phone: existing.recipient_phone,
            airtimeStatus: existing.airtime_status,
            message: 'This airtime purchase was already completed.',
          });
        }
        reference = existing.payment_reference;
      } else {
        reference = `AIR-${crypto.randomUUID()}`;
        try {
          const { error: insertError } = await admin.from('airtime_orders').insert({
            user_id: agentId,
            agent_id: agentId,
            payment_reference: reference,
            recipient_phone: phone,
            network,
            amount: netAmount,
            fee_amount: feeAmount,
            gross_amount: grossAmount,
            payment_method: 'paystack',
            payment_status: 'pending_payment',
            airtime_status: 'pending',
            customer_name: customerName,
            customer_email: customerEmail,
            idempotency_key: clientRequestId,
          });
          if (insertError) throw insertError;
        } catch (insertError) {
          const code = (insertError as { code?: string })?.code ?? '';
          if (code === '23505' && clientRequestId) {
            const dupe = await findIdempotentOrder(admin, clientRequestId, agentId);
            if (dupe && dupe.payment_method === 'paystack') {
              reference = dupe.payment_reference;
            } else {
              return json({ error: 'This purchase is already being processed. Please wait.' }, 409);
            }
          } else {
            throw insertError;
          }
        }
      }
    } else {
      reference = `AIR-${crypto.randomUUID()}`;
      const { error: insertError } = await admin.from('airtime_orders').insert({
        user_id: agentId,
        agent_id: agentId,
        payment_reference: reference,
        recipient_phone: phone,
        network,
        amount: netAmount,
        fee_amount: feeAmount,
        gross_amount: grossAmount,
        payment_method: 'paystack',
        payment_status: 'pending_payment',
        airtime_status: 'pending',
        customer_name: customerName,
        customer_email: customerEmail,
      });
      if (insertError) throw insertError;
    }

    // 2. Initialize Paystack transaction
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY');
    const siteUrl = Deno.env.get('SITE_URL');
    if (!paystackSecret || !siteUrl) {
      throw new Error('Payment configuration is missing (PAYSTACK_SECRET_KEY or SITE_URL).');
    }

    const callbackUrl = `${siteUrl.replace(/\/$/, '')}/airtime.html?reference=${encodeURIComponent(reference)}`;

    const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${paystackSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: Math.round(grossAmount * 100),
        currency: 'GHS',
        reference,
        callback_url: callbackUrl,
        metadata: {
          payment_type: 'airtime',
          phone,
          network,
          net_amount: netAmount,
          fee_amount: feeAmount,
          gross_amount: grossAmount,
          agent_id: agentId,
        },
      }),
    });

    const payment = await paystackResponse.json();

    if (!paystackResponse.ok || payment.status !== true || !payment.data?.authorization_url) {
      console.error('Paystack initialization failure:', payment);
      throw new Error(payment.message || 'Paystack could not initialize payment.');
    }

    return json({
      authorizationUrl: payment.data.authorization_url,
      reference,
      netAmount,
      feeAmount,
      grossAmount,
      phone,
      network,
    });
  } catch (error) {
    console.error('Airtime payment creation error:', error);
    const message = error instanceof Error ? error.message : 'Unable to initialize airtime purchase.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({ error: message }, status);
  }
});