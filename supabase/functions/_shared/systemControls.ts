import { adminClient } from './supabase.ts';

export type SystemServiceKey =
  | 'afa_registration'
  | 'results_checker'
  | 'utility_bills'
  | 'airtime_top_up';

export class SystemServiceUnavailableError extends Error {
  code = 'service_out_of_stock';
  serviceKey: SystemServiceKey;

  constructor(serviceKey: SystemServiceKey, reason?: string | null) {
    super(reason?.trim() || `${serviceLabel(serviceKey)} is currently out of stock.`);
    this.name = 'SystemServiceUnavailableError';
    this.serviceKey = serviceKey;
  }
}
export const SYSTEM_SERVICE_LABELS: Record<SystemServiceKey, string> = {
  afa_registration: 'AFA Registration',
  results_checker: 'Results Checker',
  utility_bills: 'Utility Bills',
  airtime_top_up: 'Airtime Top-Up',
};

function serviceLabel(serviceKey: SystemServiceKey): string {
  return SYSTEM_SERVICE_LABELS[serviceKey] || 'This service';
}

/** Missing rows default to available for backwards-compatible deployments. */
export async function isSystemServiceAvailable(
  serviceKey: SystemServiceKey,
  client = adminClient(),
): Promise<{ available: boolean; reason: string | null }> {
  const { data, error } = await client
    .from('system_service_controls')
    .select('available, unavailable_reason')
    .eq('service_key', serviceKey)
    .maybeSingle();

  if (error) {
    console.warn(`System control read failed for ${serviceKey}; leaving service available:`, error.message);
    return { available: true, reason: null };
  }
  return {
    available: data?.available !== false,
    reason: data?.unavailable_reason ? String(data.unavailable_reason) : null,
  };
}

export async function requireSystemServiceAvailable(
  serviceKey: SystemServiceKey,
  client = adminClient(),
): Promise<void> {
  const control = await isSystemServiceAvailable(serviceKey, client);
  if (!control.available) throw new SystemServiceUnavailableError(serviceKey, control.reason);
}
