/**
 * Data Bundle Provider Integration for Skaitech Ghana
 * Provider: GrandTechHub Reseller API
 *
 * Catalog:  GET  https://backend.grandtechub.cloud/api/packages
 *             - payload: [{ id, size, network, price, type }]
 *             - `size` is in GB, `price` is in pesewas (400 => GHS 4.00)
 *             - `network` is one of MTN, TELECEL, AIRTELTIGO_ISHARE,
 *               AIRTELTIGO_BIGTIME, or legacy AIRTELTIGO
 * Purchase: POST https://backend.grandtechub.cloud/api/orders
 *             - body: { packages: [{ network, packageId, phone }] }
 *             - auth: x-api-key: <GRANDTECH_API_KEY>
 *
 * Orders are accepted asynchronously: a 201 means the provider took the order
 * and reserved the balance, not that the bundle has already landed. The
 * provider can POST a status update to the `callback` we send with the order.
 */

import { grandtechApiKey } from './afaProvider.ts';

const GRANDTECH_DEFAULT_BASE = 'https://backend.grandtechub.cloud';

export interface GrandTechPackage {
  id: string;
  sizeGb: number;
  priceGhs: number;
  providerNetwork: string;
  network: string;
  /** Units already sold, or null when the provider does not track it. */
  sales: number | null;
  /** Sales cap, or null when unlimited. */
  limit: number | null;
  /**
   * True when the package exists but has hit its sales cap. The order endpoint
   * still accepts these, so relying on acceptance to detect them means
   * charging customers for bundles that never arrive.
   */
  soldOut: boolean;
}

export interface GrandTechBuyResult {
  success: boolean;
  orderId?: string;
  totalPrice?: number;
  payload: Record<string, unknown>;
  failureReason?: string;
}

/**
 * Strips everything we do not need out of a provider response before it is
 * logged or written to the database.
 *
 * The GrandTechHub order endpoint echoes the reseller account itself back in an
 * `identity` object, which includes the API key and a password hash. Persisting
 * or logging the raw response would copy those secrets into every row of
 * public_data_orders / agent_data_orders, so only known-safe fields are kept.
 */
export function sanitizeGrandTechPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const source = payload && typeof payload === 'object' ? payload : {};
  const safe: Record<string, unknown> = {};

  for (const key of ['orderId', 'totalPrice', 'status', 'createdAt', 'message', 'error']) {
    const value = source[key];
    if (value !== undefined && value !== null) safe[key] = value;
  }

  if (Array.isArray(source.packages)) {
    safe.packages = (source.packages as Record<string, unknown>[]).map((pkg) => {
      const entry: Record<string, unknown> = {};
      for (const key of ['network', 'packageId', 'size', 'price', 'status']) {
        const value = pkg?.[key];
        if (value !== undefined && value !== null) entry[key] = value;
      }
      return entry;
    });
  }

  return safe;
}

export function grandtechDataBaseUrl(): string {
  const explicit = Deno.env.get('GRANDTECH_DATA_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  return GRANDTECH_DEFAULT_BASE;
}

/**
 * GrandTechHub uses its own network codes. Note AIRTELTIGO_ISHARE (daily
 * bundle) and AIRTELTIGO_BIGTIME (monthly "BigTime") are separate products,
 * so a bare AIRTELTIGO is treated as the legacy code and is not auto-matched.
 */
const NETWORK_MAP: Record<string, string> = {
  mtn: 'MTN',
  telecel: 'TELECEL',
  airteltigo: 'AIRTELTIGO_ISHARE',
  airteltigo_ishare: 'AIRTELTIGO_ISHARE',
  at: 'AIRTELTIGO_ISHARE',
  airteltigo_bigtime: 'AIRTELTIGO_BIGTIME',
  bigtime: 'AIRTELTIGO_BIGTIME',
};

export function normalizeDataNetwork(networkType: string): string {
  const key = String(networkType || '').trim().toLowerCase();
  return NETWORK_MAP[key] || key.toUpperCase();
}

/**
 * Optional endpoint the provider POSTs order status updates to.
 *
 * Left unset by default: the provider's order-status callback payload is not
 * documented, so sending a URL we cannot yet handle would just produce 404s.
 * Set GRANDTECH_DATA_CALLBACK once the data-order-webhook function exists.
 */
export function grandtechOrderCallbackUrl(): string | null {
  const explicit = Deno.env.get('GRANDTECH_DATA_CALLBACK');
  return explicit ? explicit : null;
}

/**
 * Lists the packages the GrandTechHub account is allowed to sell. These IDs are
 * what the order endpoint validates against, so the catalog here is also the
 * guard against offering a size the provider cannot actually deliver.
 */
export async function fetchGrandTechPackages(): Promise<GrandTechPackage[]> {
  const response = await fetch(`${grandtechDataBaseUrl()}/api/packages`, {
    headers: {
      'x-api-key': grandtechApiKey(),
      Accept: 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || !Array.isArray(payload?.payload)) {
    console.error('GrandTechHub catalog fetch failed:', payload);
    throw new Error('Unable to fetch the data bundle catalog.');
  }

  return (payload.payload as Record<string, unknown>[])
    .map((pkg) => {
      const providerNetwork = String(pkg.network || '').toUpperCase();
      const priceGhs = Number(pkg.price) / 100;
      const sizeGb = Number(pkg.size);
      if (!pkg.id || !providerNetwork || !Number.isFinite(priceGhs) || !Number.isFinite(sizeGb)) {
        return null;
      }
      // Number(null) is 0, so null has to be ruled out before coercing or every
      // uncapped package would look like it had hit a limit of zero.
      const sales = pkg.sales === null || pkg.sales === undefined
        ? null
        : (Number.isFinite(Number(pkg.sales)) ? Number(pkg.sales) : null);
      const limit = pkg.limit === null || pkg.limit === undefined
        ? null
        : (Number.isFinite(Number(pkg.limit)) ? Number(pkg.limit) : null);
      return {
        id: String(pkg.id),
        sizeGb,
        priceGhs: Math.round(priceGhs * 100) / 100,
        providerNetwork,
        network: providerNetwork.toLowerCase(),
        sales,
        limit,
        soldOut: limit !== null && sales !== null && sales >= limit,
      } satisfies GrandTechPackage;
    })
    .filter((pkg): pkg is GrandTechPackage => pkg !== null);
}

/**
 * Finds the provider package for a network + volume, or null when the provider
 * cannot actually deliver it - either because the size does not exist or
 * because it has hit its sales cap. A null result must abort the order and
 * refund the wallet.
 */
export async function resolveGrandTechPackage(
  networkType: string,
  volumeInMB: number,
): Promise<GrandTechPackage | null> {
  const packages = await fetchGrandTechPackages();
  const providerNetwork = normalizeDataNetwork(networkType);
  const sizeGb = volumeInMB / 1024;

  const matches = packages
    .filter((pkg) => pkg.providerNetwork === providerNetwork && pkg.sizeGb === sizeGb && !pkg.soldOut)
    .sort((a, b) => a.priceGhs - b.priceGhs);

  return matches[0] ?? null;
}

/** Provider order status vocabulary, mapped onto our own states. */
export type GrandTechOrderState = 'successful' | 'failed' | 'cancelled' | 'processing';

const SUCCESSFUL_STATES = new Set(['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'DELIVERED', 'FULFILLED']);
const FAILED_STATES = new Set(['FAILED', 'FAILURE', 'REJECTED', 'EXPIRED']);
const CANCELLED_STATES = new Set(['CANCELLED', 'CANCELED']);

export function mapGrandTechOrderState(status: string): GrandTechOrderState {
  const normalized = String(status || '').trim().toUpperCase();
  if (SUCCESSFUL_STATES.has(normalized)) return 'successful';
  if (CANCELLED_STATES.has(normalized)) return 'cancelled';
  if (FAILED_STATES.has(normalized)) return 'failed';
  return 'processing';
}

/**
 * Reads the live status of a provider order. The provider accepts orders long
 * before the bundle is delivered, and orders can sit in PENDING/PROCESSING
 * indefinitely, so acceptance alone must never be treated as delivery.
 */
export async function fetchGrandTechOrderStatus(
  providerOrderId: string,
): Promise<{ state: GrandTechOrderState; status: string; createdAt: string | null } | null> {
  if (!providerOrderId) return null;

  let url = `${grandtechDataBaseUrl()}/api/orders`;
  // The provider paginates, so walk the pages until the order shows up.
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetch(`${url}?page=${page}&limit=100`, {
      headers: { 'x-api-key': grandtechApiKey(), Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Array.isArray(payload?.payload)) return null;

    const orders = payload.payload as Record<string, unknown>[];
    const match = orders.find((o) => String(o.orderId ?? '') === String(providerOrderId));
    if (match) {
      const packages = Array.isArray(match.packages) ? match.packages as Record<string, unknown>[] : [];
      const statuses = packages.map((p) => String(p.status ?? ''));
      // An order with several packages only counts as delivered if all of them are.
      let state: GrandTechOrderState = 'processing';
      if (statuses.length && statuses.every((s) => mapGrandTechOrderState(s) === 'successful')) {
        state = 'successful';
      } else if (statuses.length && statuses.every((s) => mapGrandTechOrderState(s) === 'failed')) {
        state = 'failed';
      }
      return {
        state,
        status: statuses.join(',') || 'UNKNOWN',
        createdAt: match.createdAt ? String(match.createdAt) : null,
      };
    }

    const totalPages = Number(payload.totalPages ?? 1);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
  }

  return null;
}

/**
 * Places the order. Never throws on a provider rejection: the caller refunds the
 * wallet when this reports failure.
 */
export async function buyGrandTechPackage(
  packageId: string,
  phone: string,
  networkType: string,
): Promise<GrandTechBuyResult> {
  try {
    const callback = grandtechOrderCallbackUrl();
    const response = await fetch(`${grandtechDataBaseUrl()}/api/orders`, {
      method: 'POST',
      headers: {
        'x-api-key': grandtechApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        packages: [{
          // The provider resolves the packageId within this network, so it has
          // to be the network the package actually belongs to.
          network: normalizeDataNetwork(networkType),
          packageId,
          phone,
          ...(callback ? { callback } : {}),
          clientReference: `DATA-${Date.now()}`,
        }],
      }),
    });

    const payload = await response.json().catch(() => ({
      raw: 'Invalid provider response',
    })) as Record<string, unknown>;

    const success = response.ok;
    return {
      success,
      orderId: payload.orderId ? String(payload.orderId) : undefined,
      totalPrice: Number.isFinite(Number(payload.totalPrice))
        ? Number(payload.totalPrice)
        : undefined,
      payload: sanitizeGrandTechPayload(payload),
      failureReason: success
        ? undefined
        : String(payload.message || payload.error || 'The data provider declined the order.'),
    };
  } catch (err) {
    return {
      success: false,
      payload: { error: String(err) },
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the data provider.',
    };
  }
}
