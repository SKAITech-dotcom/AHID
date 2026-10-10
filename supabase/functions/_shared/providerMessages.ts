/**
 * Provider-error translation for the wallet storefront (data + airtime).
 *
 * Providers return terse vendor wording - one Swift error is literally "This
 * number is being enabled for MTN data. Please try again after 24 hours." -
 * which is accurate but reads as if our validation judged the AirtelTigo or
 * Telecel order as MTN. It is not: that is Swift refusing to switch a recently
 * activated number to another network within its cooldown window. Surfacing
 * that wording verbatim is what the issue report called an "incorrect pop-up".
 *
 * The rules here wrap vendor failure reasons in clean UI copy. They never
 * change routing, and they only touch the message the customer sees - the raw
 * provider payload and any audit log keep the original string.
 */

const NETWORK_LABELS: Record<string, string> = {
  mtn: 'MTN',
  telecel: 'Telecel',
  at: 'AirtelTigo',
  airteltigo: 'AirtelTigo',
  tigo: 'AirtelTigo',
  vodafone: 'Telecel',
};

export function networkLabel(networkType?: string): string {
  const key = String(networkType || '').trim().replace(/[\s_-]/g, '').toLowerCase();
  if (key === 'telecel' || key === 'vodafone') return 'Telecel';
  if (key === 'at' || key === 'airteltigo' || /^(?:at(?:data|bundle|network)?|airtel.*tigo|tigo)/.test(key)) {
    return 'AirtelTigo';
  }
  return NETWORK_LABELS[key] ?? String(networkType || 'this network');
}

/**
 * The 24-hour cooldown is real (a number just enabled on one network cannot be
 * switched to another within the window) but the vendor message names the wrong
 * thing. This pattern catches that wording wherever the provider rewraps it.
 */
function isNetworkCooldown(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (lower.includes('being enabled') || lower.includes('enabled for') || lower.includes('24 hours') ||
    lower.includes('24hrs') || lower.includes('cooldown')) &&
    /mtn|data|network|enabl/i.test(lower);
}

function isInsufficientBalance(raw: string): boolean {
  return /insufficient|low balance|not enough (balance|funds)|top up|wallet balance|fund your account/i.test(raw);
}

function isInvalidRecipient(raw: string): boolean {
  return /invalid (number|recipient|msisdn)|wrong number|not a (valid|registered) number|number.*not.*(found|valid)|unrecogni[sz]ed number/i.test(raw);
}

function isNetworkUnavailable(raw: string): boolean {
  return /not available|temporarily|try again|service unavailable|under maintenance|maintenance|currently (down|unavailable)|allowed for|restricted|blocked|paused/i.test(raw);
}

function isTransportFailure(raw: string): boolean {
  return /fetch failed|network error|timeout|timed? ?out|econn|socket|connection (reset|refused|closed)/i.test(raw);
}

/**
 * Maps a provider failure reason to copy a customer can act on. Unmatched
 * reasons pass through unchanged so a brand-new vendor message is not papered
 * over by a wrong explanation.
 */
export function friendlyProviderMessage(reason: unknown, networkType?: string): string {
  const raw = String(reason ?? '').trim();
  if (!raw) return 'The provider did not complete the order.';
  const label = networkLabel(networkType);

  if (isNetworkCooldown(raw)) {
    return `${label} cannot send data to that number right now because the number was recently activated on another network. Network providers require a 24-hour wait before switching. Please try again later - no charge was kept when this failed.`;
  }

  if (isInsufficientBalance(raw)) {
    return 'Our data supplier reported an insufficient balance for this request. No charge was kept - please try again shortly.';
  }

  if (isInvalidRecipient(raw)) {
    return `The recipient number does not look valid for ${label} data. Check the number and try again - no charge was kept.`;
  }

  if (isNetworkUnavailable(raw)) {
    return `${label} data delivery is temporarily unavailable from our supplier. No charge was kept - please try again in a few minutes.`;
  }

  if (isTransportFailure(raw)) {
    return 'We could not confirm the order with the data provider. No charge was kept - please check your transaction status before retrying.';
  }

  return raw;
}