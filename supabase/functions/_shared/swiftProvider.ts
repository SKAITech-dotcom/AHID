/**
 * Data Bundle Provider Integration for Skaitech Ghana
 * Provider: Swift Vendux Reseller API
 *
 * Catalog:  GET  https://swiftvendux.com/api/v1/developer/v1/packages/
 *             - packages: [{ id, name, network, price, validity, category }]
 * Purchase: POST https://swiftvendux.com/api/v1/developer/v1/buy/
 *             - body: { package_id, phone }
 *             - auth: Authorization: Bearer <DATA_API_KEY>
 */

export interface SwiftPackage {
  id: string;
  name: string;
  network: string;
  price: string | number;
  validity?: string;
  category?: string;
}

export interface SwiftBuyResult {
  success: boolean;
  orderId?: string;
  status?: string;
  amount?: number;
  payload: Record<string, unknown>;
  failureReason?: string;
}

const SWIFT_BASE_URL = 'https://swiftvendux.com/api/v1/developer/v1';

function swiftApiKey() {
  const key = Deno.env.get('DATA_API_KEY');
  if (!key) throw new Error('Swift data provider API key is not configured.');
  return key;
}

function normalizeNetwork(networkType: string): string {
  const map: Record<string, string> = {
    mtn: 'MTN',
    telecel: 'TELECEL',
    airteltigo: 'AIRTELTIGO',
    at: 'AT',
  };
  return map[networkType] || networkType.toUpperCase();
}

export async function fetchSwiftPackages(): Promise<SwiftPackage[]> {
  const response = await fetch(`${SWIFT_BASE_URL}/packages/`, {
    headers: {
      Authorization: `Bearer ${swiftApiKey()}`,
      Accept: 'application/json',
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload?.packages)) {
    console.error('Swift catalog fetch failed:', payload);
    throw new Error('Unable to fetch the Swift bundle catalog.');
  }
  return (payload.packages as SwiftPackage[]).filter(
    (pkg) => String(pkg.category || 'data').toLowerCase() === 'data',
  );
}

function volumeToGbLabel(volumeInMB: number): string {
  const gb = volumeInMB / 1024;
  return Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(2);
}

/**
 * Resolve the cheapest Swift package whose name matches the requested
 * network + volume. Package names look like "1GB MTN", "5GB AT", etc.
 */
export async function resolveSwiftPackage(networkType: string, volumeInMB: number): Promise<SwiftPackage | null> {
  const packages = await fetchSwiftPackages();
  const network = normalizeNetwork(networkType);
  const gbLabel = volumeToGbLabel(volumeInMB);
  const probe = new RegExp(`\\b${gbLabel}\\s*gb\\b`, 'i');

  const matches = packages
    .filter((pkg) => pkg.network.toUpperCase() === network && probe.test(pkg.name))
    .sort((a, b) => Number(a.price) - Number(b.price));

  return matches[0] ?? null;
}

export async function buySwiftPackage(packageId: string, phone: string): Promise<SwiftBuyResult> {
  try {
    const response = await fetch(`${SWIFT_BASE_URL}/buy/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${swiftApiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ package_id: packageId, phone }),
    });
    const payload = await response.json().catch(() => ({ raw: 'Invalid provider response' })) as Record<string, unknown>;
    const success = response.ok && payload.success === true;
    return {
      success,
      orderId: payload.order_id ? String(payload.order_id) : undefined,
      status: payload.status ? String(payload.status) : undefined,
      amount: Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : undefined,
      payload,
      failureReason: success ? undefined : String(payload.message || payload.error || 'Swift declined the data order.'),
    };
  } catch (err) {
    return {
      success: false,
      payload: { error: String(err) },
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the Swift provider.',
    };
  }
}