/**
 * AFA (Aid & Food Allowance / Farmer) Provider Integration for Skaitech Ghana
 * Provider: GrandTechHub AFA API
 *
 * Endpoint: POST https://backend.grandtech.cloud/api/afa
 * Headers:  x-api-key: <GRANDTECH_API_KEY>
 *           Content-Type: application/json
 * Body:     { fullName, phoneNumber, town, occupation, priceId, idNumber,
 *             idType, date_of_birth, callback }
 */

export interface AfaSubmission {
  fullName: string;
  phoneNumber: string;
  town: string;
  occupation: string;
  priceId: string;
  idNumber: string;
  idType: string;
  dateOfBirth: string; // YYYY-MM-DD
  reference: string;
}

export interface AfaSubmitResult {
  success: boolean;
  providerReference?: string;
  providerResponse?: Record<string, unknown>;
  failureReason?: string;
}

const GRANDTECH_AFA_URL = 'https://backend.grandtech.cloud/api/afa';

export function grandtechApiKey(): string {
  const key = Deno.env.get('GRANDTECH_API_KEY');
  if (!key) throw new Error('AFA provider API key is not configured.');
  return key;
}

export function afaCallbackUrl(reference: string): string {
  const siteUrl = Deno.env.get('SITE_URL');
  const base = siteUrl?.replace(/\/+$/, '') || 'https://skaitechgh.com';
  return `${base}/AFA.html?reference=${encodeURIComponent(reference)}`;
}

/**
 * Submits an AFA registration to GrandTechHub. Never throws on a provider
 * rejection; returns a structured result so the caller can refund the wallet.
 */
export async function submitAfaRegistration(data: AfaSubmission): Promise<AfaSubmitResult> {
  const apiKey = grandtechApiKey();
  const priceId = data.priceId || Deno.env.get('GRANDTECH_AFA_PRICE_ID') || '';

  const payload = {
    fullName: data.fullName,
    phoneNumber: data.phoneNumber,
    town: data.town,
    occupation: data.occupation,
    priceId,
    idNumber: data.idNumber,
    idType: data.idType,
    date_of_birth: data.dateOfBirth,
    callback: afaCallbackUrl(data.reference),
    clientReference: data.reference,
  };

  try {
    const response = await fetch(GRANDTECH_AFA_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json().catch(() => ({})) as Record<string, unknown>;

    const ok = response.ok || (response.status >= 200 && response.status < 300);
    const flaggedFailed = String(responseData.status ?? responseData.Status ?? '')
      .toLowerCase() === 'failed';
    const hasErrorMarker = Boolean(
      responseData.error || responseData.message || responseData.failure_reason,
    );

    if (ok && !flaggedFailed && !hasErrorMarker) {
      return {
        success: true,
        providerReference: String(
          responseData.reference ??
          responseData.provider_reference ??
          responseData.id ??
          responseData.transactionId ??
          '',
        ) || undefined,
        providerResponse: responseData,
      };
    }

    return {
      success: false,
      failureReason: String(
        responseData.message ||
        responseData.error ||
        responseData.failure_reason ||
        responseData.description ||
        (ok ? 'The AFA provider did not confirm the registration.' : `AFA provider request failed (HTTP ${response.status}).`),
      ),
      providerResponse: responseData,
    };
  } catch (err) {
    console.error('GrandTechHub AFA dispatch error:', err);
    return {
      success: false,
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the AFA provider.',
      providerResponse: { error: String(err) },
    };
  }
}