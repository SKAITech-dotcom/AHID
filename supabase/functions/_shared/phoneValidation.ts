const NETWORK_PREFIXES: Record<string, string[]> = {
  mtn: ['024', '025', '053', '054', '055', '059'],
  telecel: ['020', '050'],
  at: ['026', '027', '056', '057'],
  airteltigo: ['026', '027', '056', '057'],
};

const NETWORK_LABELS: Record<string, string> = {
  mtn: 'MTN',
  telecel: 'Telecel',
  at: 'AT',
  airteltigo: 'AT',
};

export function networkPhoneError(network: string, phone: string): string | null {
  const normalizedNetwork = String(network || '').trim().toLowerCase();
  const normalizedPhone = String(phone || '').replace(/[\s()-]/g, '');
  if (!/^0\d{9}$/.test(normalizedPhone)) return 'Enter a valid 10-digit Ghanaian phone number.';

  const prefixes = NETWORK_PREFIXES[normalizedNetwork];
  if (!prefixes) return null;
  if (prefixes.includes(normalizedPhone.slice(0, 3))) return null;

  const label = NETWORK_LABELS[normalizedNetwork] || normalizedNetwork.toUpperCase();
  return `This number is not an ${label} number. Enter a valid ${label} number for the selected network.`;
}
