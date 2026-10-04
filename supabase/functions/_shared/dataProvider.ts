/**
 * Data bundle provider facade.
 *
 * GrandTechHub is the primary provider: it is the account we already fund for
 * AFA, and its catalog is the authority on which network + size combinations
 * can actually be delivered. Swift Vendux stays wired up as a fallback via
 * DATA_PROVIDER=swift, so the old route is one env var away.
 */

import { buySwiftPackage, resolveSwiftPackage } from './swiftProvider.ts';
import {
  buyGrandTechPackage,
  fetchGrandTechOrderStatus,
  resolveGrandTechPackage,
  type GrandTechOrderState,
  type GrandTechPackage,
} from './grandtechDataProvider.ts';

export type DataProviderName = 'grandtech' | 'swift';

export interface ResolvedDataPackage {
  provider: DataProviderName;
  id: string;
  /** What the provider charges us, in GHS. Used for margin reporting. */
  costGhs: number;
  raw: GrandTechPackage | { id: string; price: string | number };
}

export interface DataBuyResult {
  success: boolean;
  provider: DataProviderName;
  orderId?: string;
  /** Mirrors the provider's own status wording where it gives us one. */
  status?: string;
  payload: Record<string, unknown>;
  failureReason?: string;
}

/** GrandTech's only designated sellable bundles; all other tiers use Swift. */
export function providerForBundle(networkType: string, volumeInMB: number): DataProviderName {
  const network = String(networkType || '').trim().toLowerCase();
  if ((network === 'mtn' && volumeInMB === 1024) ||
      (network === 'telecel' && volumeInMB === 5120)) return 'grandtech';
  return 'swift';
}

/** Provider fallback for legacy orders whose provider was not saved. */
export function activeDataProvider(networkType?: string, volumeInMB?: number): DataProviderName {
  if (networkType && Number.isFinite(volumeInMB)) {
    return providerForBundle(networkType, Number(volumeInMB));
  }
  return 'swift';
}

/**
 * Resolves the provider package for a network + volume, or null when the
 * provider does not offer that combination. A null result must abort the order
 * and refund - it means we would be selling something undeliverable.
 */
export async function resolveDataPackage(
  networkType: string,
  volumeInMB: number,
): Promise<ResolvedDataPackage | null> {
  if (providerForBundle(networkType, volumeInMB) === 'grandtech') {
    const pkg = await resolveGrandTechPackage(networkType, volumeInMB);
    if (!pkg) return null;
    return { provider: 'grandtech', id: pkg.id, costGhs: pkg.priceGhs, raw: pkg };
  }

  const pkg = await resolveSwiftPackage(networkType, volumeInMB);
  if (!pkg) return null;
  return {
    provider: 'swift',
    id: pkg.id,
    costGhs: Number(pkg.price),
    raw: pkg,
  };
}

export async function buyDataPackage(
  resolved: ResolvedDataPackage,
  networkType: string,
  phone: string,
): Promise<DataBuyResult> {
  if (resolved.provider === 'grandtech') {
    const result = await buyGrandTechPackage(resolved.id, phone, networkType);
    return {
      success: result.success,
      provider: 'grandtech',
      orderId: result.orderId,
      // GrandTechHub accepting the order only means it reserved the balance. The
      // bundle is delivered later, so the order stays in 'processing' until a
      // status poll (or a callback) confirms the outcome.
      status: result.success ? 'processing' : 'failed',
      payload: result.payload,
      failureReason: result.failureReason,
    };
  }

  const result = await buySwiftPackage(resolved.id, phone);
  return {
    success: result.success,
    provider: 'swift',
    orderId: result.orderId,
    status: result.status,
    payload: result.payload,
    failureReason: result.failureReason,
  };
}

/**
 * Live delivery status for an order we already placed. Returns null when the
 * provider cannot be consulted, which callers must treat as "still unknown"
 * rather than as a failure.
 */
export async function fetchDataOrderStatus(
  provider: DataProviderName,
  providerOrderId: string,
): Promise<{ state: GrandTechOrderState; status: string } | null> {
  if (provider !== 'grandtech') return null;
  const result = await fetchGrandTechOrderStatus(providerOrderId);
  return result ? { state: result.state, status: result.status } : null;
}

/**
 * How long an accepted order may sit undelivered before we assume the provider
 * dropped it and refund the customer. Generous, because a late delivery we then
 * refund is a loss, but bounded so nobody is left having paid for nothing.
 */
export function dataOrderStuckMinutes(): number {
  const configured = Number(Deno.env.get('DATA_ORDER_STUCK_MINUTES'));
  return Number.isFinite(configured) && configured > 0 ? configured : 45;
}
