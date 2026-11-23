import { adminClient } from './supabase.ts';

export class WalletError extends Error {
  readonly code: 'insufficient' | 'other';
  constructor(message: string, code: 'insufficient' | 'other' = 'other') {
    super(message);
    this.code = code;
  }
}

function requirePositiveAmount(amount: number, label: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new WalletError(`${label} must be greater than zero.`);
  }
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(value - rounded) > 1e-9) {
    throw new WalletError(`${label} must have no more than two decimal places.`);
  }
  return rounded;
}

/**
 * Atomically debits an agent wallet and records the ledger entry.
 * Returns the new wallet balance.
 */
export async function chargeWallet(
  agentId: string,
  reference: string,
  amount: number,
  description = 'Service purchase',
  meta: Record<string, unknown> = {},
): Promise<number> {
  const safeAmount = requirePositiveAmount(amount, 'Payment amount');
  const { data, error } = await adminClient().rpc('charge_agent_wallet', {
    p_agent_id: agentId,
    p_reference: reference,
    p_amount: safeAmount,
    p_description: description,
    p_meta: meta,
  });
  if (error) {
    if (String(error.message || '').toLowerCase().includes('insufficient')) {
      throw new WalletError(String(error.message), 'insufficient');
    }
    throw new WalletError(String(error.message || 'Failed to charge wallet.'));
  }
  return Number(data);
}

/**
 * Atomically reverses a previous wallet debit. Idempotent.
 * Returns the new wallet balance.
 */
export async function refundWallet(
  agentId: string,
  debitReference: string,
  amount: number,
  reason = 'Refund for failed service',
): Promise<number> {
  const safeAmount = requirePositiveAmount(amount, 'Refund amount');
  const { data, error } = await adminClient().rpc('refund_agent_wallet', {
    p_agent_id: agentId,
    p_debit_reference: debitReference,
    p_amount: safeAmount,
    p_reason: reason,
  });
  if (error) {
    throw new WalletError(String(error.message || 'Failed to refund wallet.'));
  }
  return Number(data);
}

/**
 * Records the provider-confirmed refund after refundWallet has reversed the
 * original debit. This is deliberately a separate idempotent RPC so the same
 * internal order and provider order can never create a second refund credit.
 */
export async function recordProviderRefund(params: {
  orderType: string;
  orderId: string;
  agentId: string;
  amount: number;
  internalReference: string;
  provider?: string | null;
  providerOrderId?: string | null;
  providerReference?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const safeAmount = requirePositiveAmount(params.amount, 'Refund amount');
  const { data, error } = await adminClient().rpc('record_agent_provider_refund', {
    p_order_type: params.orderType,
    p_order_id: params.orderId,
    p_agent_id: params.agentId,
    p_amount: safeAmount,
    p_internal_reference: params.internalReference,
    p_provider: params.provider || null,
    p_provider_order_id: params.providerOrderId || null,
    p_provider_reference: params.providerReference || null,
    p_reason: params.reason,
    p_metadata: params.metadata || {},
  });
  if (error) {
    throw new WalletError(String(error.message || 'Failed to record provider refund.'));
  }
  return String(data);
}

/**
 * Atomically credits an agent wallet (e.g. for store sales profit) and records the ledger entry.
 * Returns the new wallet balance.
 */
export async function creditWallet(
  agentId: string,
  reference: string,
  amount: number,
  description = 'Store profit commission',
  meta: Record<string, unknown> = {},
): Promise<number> {
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    throw new WalletError('Credit amount cannot be negative.');
  }
  if (Number(amount) === 0) {
    return await getWalletBalance(agentId);
  }
  const safeAmount = requirePositiveAmount(amount, 'Credit amount');
  const admin = adminClient();
  const { data, error } = await admin.rpc('credit_agent_wallet', {
    p_agent_id: agentId,
    p_reference: reference,
    p_amount: safeAmount,
    p_description: description,
    p_meta: meta,
  });

  if (error) {
    // RPC not available — this should not happen in production.
    // Do NOT fall back to inline arithmetic; log and throw instead.
    console.error('credit_agent_wallet RPC failed:', error.message);
    throw new WalletError(
      `Failed to credit wallet: ${error.message || 'RPC unavailable'}. Contact support.`,
    );
  }
  return Number(data);
}

export async function getWalletBalance(agentId: string): Promise<number> {
  const { data, error } = await adminClient()
    .from('wallets')
    .select('balance')
    .eq('id', agentId)
    .maybeSingle();
  if (error) return Number.NaN;
  return Number(data?.balance ?? 0);
}
