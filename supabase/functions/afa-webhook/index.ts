/**
 * AFA status webhook (GrandTechHub -> Skaitech).
 *
 * The provider POSTs { afaId, status, fullName, updatedAt } to the callback URL
 * we supplied when submitting the registration.
 *
 * This MUST be a server endpoint: the frontend is static hosting (Wasmer) and
 * cannot accept POSTs, so this runs as an Edge Function instead.
 *
 * Deployed with --no-verify-jwt because the provider cannot send a Supabase JWT.
 * Use AFA_WEBHOOK_SECRET to require a shared secret when the provider can send
 * a custom header.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { refundWallet } from '../_shared/wallet.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/**
 * Maps the provider's own status wording onto our four allowed values.
 * Unknown wording becomes 'Processing' so we never falsely mark a payment as
 * completed.
 */
function mapStatus(raw: unknown): { status: string; failure: string | null } {
  const value = String(raw ?? '').trim();
  const key = value.toLowerCase().replace(/[\s_-]+/g, ' ');

  if (/^(completed|complete|success|successful|approved|approved|active|delivered|confirmed|paid|true)$/.test(key) ||
      /\b(completed|successful|success|approved|delivered|confirmed)\b/.test(key)) {
    return { status: 'Completed', failure: null };
  }

  if (/^(cancel|cancelled|canceled|failed|failure|rejected|declined|denied|error|expired)$/.test(key) ||
      /\b(cancelled|canceled|failed|failure|rejected|declined|denied|expired)\b/.test(key)) {
    return { status: 'Cancelled', failure: `Provider reported: ${value}` };
  }

  if (/^(processing|in progress|inprogress|submitted|received|queued|pending|new|initiated)$/.test(key) ||
      /\b(processing|progress|submitted|received|queued|pending|initiated)\b/.test(key)) {
    return { status: 'Processing', failure: null };
  }

  return { status: 'Processing', failure: null };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return json({ ok: true, service: 'afa-webhook', expects: 'POST' });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  // Optional shared-secret check (only enforced when the secret is configured).
  const expected = Deno.env.get('AFA_WEBHOOK_SECRET');
  if (expected) {
    const url = new URL(req.url);
    const provided =
      req.headers.get('x-webhook-secret') ||
      req.headers.get('x-afa-secret') ||
      url.searchParams.get('secret') ||
      '';
    if (provided !== expected) {
      console.warn('afa-webhook: rejected request with invalid secret');
      return json({ success: false, error: 'Invalid secret' }, 401);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const afaId = String(body.afaId ?? body.afa_id ?? '').trim();
  const rawStatus = body.status;
  const updatedAt = body.updatedAt ?? body.updated_at ?? null;

  if (!afaId) {
    return json({ success: false, error: 'Missing afaId' }, 400);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('afa-webhook: Supabase env missing');
    return json({ success: false, error: 'Server misconfigured' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { status: mapped, failure } = mapStatus(rawStatus);

  // Match only the provider reference. A name-only fallback would allow an
  // unauthenticated caller to alter the newest registration for that name.
  const { data: found, error: findError } = await supabase
    .from('afa_registrations')
    .select('id, reference, status, created_by, amount, provider_response')
    .eq('provider_reference', afaId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    console.error('afa-webhook: lookup failed:', findError.message);
    return json({ success: false, error: 'Lookup failed' }, 500);
  }

  if (!found) {
    console.warn(`afa-webhook: no registration matched afaId=${afaId}`);
    return json({ success: false, error: 'Registration not found' }, 404);
  }

  const currentStatus = String(found.status || 'Processing');
  const protectedStatus = ['Completed', 'Cancelled'].includes(currentStatus) && mapped !== 'Completed'
    ? currentStatus
    : mapped;
  const providerUpdatedAt = updatedAt && Number.isFinite(Date.parse(String(updatedAt)))
    ? new Date(String(updatedAt)).toISOString()
    : new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: protectedStatus,
    provider_status: String(rawStatus ?? protectedStatus),
    provider_updated_at: providerUpdatedAt,
    ...(afaId ? { provider_reference: afaId } : {}),
    updated_at: new Date().toISOString(),
  };
  if (failure && protectedStatus !== 'Completed') patch.failure_reason = failure;

  const previousProviderResponse = found.provider_response && typeof found.provider_response === 'object'
    ? found.provider_response as Record<string, unknown>
    : {};
  patch.provider_response = {
    ...previousProviderResponse,
    webhook: body,
    lastProviderStatus: String(rawStatus ?? mapped),
    lastProviderState: mapped,
    lastStatusCheckedAt: new Date().toISOString(),
    ...(updatedAt ? { provider_updated_at: updatedAt } : {}),
  };

  const { error: updateError } = await supabase
    .from('afa_registrations')
    .update(patch)
    .eq('id', found.id);

  if (updateError) {
    console.error('afa-webhook: update failed:', updateError.message);
    return json({ success: false, error: 'Update failed' }, 500);
  }

  let refunded = false;
  if (protectedStatus === 'Cancelled' && found.created_by && !['Completed', 'Cancelled'].includes(String(found.status))) {
    try {
      await refundWallet(
        String(found.created_by),
        String(found.reference),
        Number(found.amount),
        'AFA registration cancelled by provider',
      );
      refunded = true;
    } catch (refundError) {
      // A webhook must be acknowledged promptly. The idempotent refund can be
      // retried from the admin flow after this error is visible in logs.
      console.error('afa-webhook: cancellation refund failed:', refundError);
    }
  }

  console.log(
    `afa-webhook: ${found.reference} ${found.status} -> ${protectedStatus} (afaId=${afaId || 'n/a'})`,
  );

  return json({ success: true, reference: found.reference, status: protectedStatus, refunded });
});
