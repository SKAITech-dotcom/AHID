import { adminClient } from './supabase.ts';

export type CustomerPaymentProvider = 'paystack' | 'hubtel';

/**
 * The default customer checkout split used before per-bundle routing existed.
 * Skaipay is the Hubtel checkout used for low/high values; Paystack handles
 * the middle band. Admin-selected rows override this safely per bundle.
 */
export function defaultCustomerPaymentProvider(amountGhs: number): CustomerPaymentProvider {
  const amount = Number(amountGhs);
  return amount >= 10 && amount <= 50 ? 'paystack' : 'hubtel';
}

export async function customerPaymentProviderForBundle(
  bundleId: string,
  amountGhs: number,
  client = adminClient(),
): Promise<CustomerPaymentProvider> {
  const fallback = defaultCustomerPaymentProvider(amountGhs);
  try {
    const { data, error } = await client
      .from('customer_payment_routes')
      .select('provider')
      .eq('bundle_id', String(bundleId || '').trim().toLowerCase())
      .maybeSingle();
    if (error) {
      console.warn('Customer payment route lookup failed; using default gateway:', error.message);
      return fallback;
    }
    const provider = String(data?.provider || '').trim().toLowerCase();
    return provider === 'paystack' ? 'paystack' : provider === 'skaipay' || provider === 'hubtel' ? 'hubtel' : fallback;
  } catch (error) {
    console.warn('Customer payment route lookup failed; using default gateway:', error);
    return fallback;
  }
}

export function customerPaymentProviderLabel(provider: CustomerPaymentProvider): string {
  return provider === 'hubtel' ? 'Skaipay (Hubtel)' : 'Paystack';
}
