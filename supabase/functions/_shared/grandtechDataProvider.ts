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
}

export interface GrandTechBuyResult {
  success: boolean;
  orderId?: string;
  totalPrice?: number;
  payload: Record<string, unknown>;
  failureReason?: string;
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
      return {
        id: String(pkg.id),
        sizeGb,
        priceGhs: Math.round(priceGhs * 100) / 100,
        providerNetwork,
        network: providerNetwork.toLowerCase(),
      } satisfies GrandTechPackage;
    })
    .filter((pkg): pkg is GrandTechPackage => pkg !== null);
}

/**
 * Finds the provider package for a network + volume. When a size is offered by
 * more than one product (for example a daily and a monthly variant) the
 * cheapest one wins, which is what protects the agent's margin.
 */
export async function resolveGrandTechPackage(
  networkType: string,
  volumeInMB: number,
): Promise<GrandTechPackage | null> {
  const packages = await fetchGrandTechPackages();
  const providerNetwork = normalizeDataNetwork(networkType);
  const sizeGb = volumeInMB / 1024;

  const matches = packages
    .filter((pkg) => pkg.providerNetwork === providerNetwork && pkg.sizeGb === sizeGb)
    .sort((a, b) => a.priceGhs - b.priceGhs);

  return matches[0] ?? null;
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
      payload,
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
