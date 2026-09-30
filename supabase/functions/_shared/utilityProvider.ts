export type UtilityProviderReply = {
  success: boolean;
  verified?: boolean;
  customerName?: string;
  token?: string;
  providerReference?: string;
  status?: string;
  message?: string;
  raw: unknown;
};

/**
 * Adapter contract for the configured Ghana utility aggregator. The provider
 * endpoint accepts { action, ...payload } and returns JSON with `success`; for
 * verify it also returns `verified` and optionally `customerName`, and for a
 * purchase it may return `token` and `providerReference`.
 */
export async function callUtilityProvider(
  action: 'verify' | 'purchase' | 'status',
  payload: Record<string, unknown>,
): Promise<UtilityProviderReply> {
  const endpoint = Deno.env.get('UTILITY_PROVIDER_API_URL');
  const apiKey = Deno.env.get('UTILITY_PROVIDER_API_KEY');
  if (!endpoint || !apiKey) {
    throw new Error('Utility provider API is not configured. Contact support before making this payment.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok || !raw || typeof raw !== 'object') {
    throw new Error('The utility provider could not process the request. Please try again later.');
  }
  const reply = raw as Record<string, unknown>;
  return {
    success: reply.success === true,
    verified: reply.verified === true,
    customerName: typeof reply.customerName === 'string' ? reply.customerName : undefined,
    token: typeof reply.token === 'string' ? reply.token : undefined,
    providerReference: typeof reply.providerReference === 'string' ? reply.providerReference : undefined,
    status: typeof reply.status === 'string' ? reply.status : undefined,
    message: typeof reply.message === 'string' ? reply.message : undefined,
    raw,
  };
}
