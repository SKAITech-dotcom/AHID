import { supabase } from './supabaseClient.js';

const QR_TRACKING_VALUE = 'qr';

function configuredOrigin() {
  const globals = typeof globalThis !== 'undefined' ? globalThis : {};
  return globals.__SKAITECH_APP_URL
    || globals.NEXT_PUBLIC_APP_URL
    || globals.VITE_APP_URL
    || '';
}

export function getBaseOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return window.location.origin.replace(/\/$/, '');
  }
  return String(configuredOrigin()).trim().replace(/\/$/, '');
}

function cleanSlug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function getAgentStoreUrl(storeSlug, { withTracking = false } = {}) {
  const slug = cleanSlug(storeSlug);
  if (!slug) return '';
  // Use the existing static storefront entrypoint. The custom Vercel domain
  // serves this file reliably, while dynamic /store/:slug rewrites are not
  // available on every connected host.
  const url = `${getBaseOrigin()}/storefront.html?slug=${encodeURIComponent(slug)}`;
  return withTracking ? `${url}&ref=${QR_TRACKING_VALUE}` : url;
}

export function getSystemRootUrl({ withTracking = false } = {}) {
  const url = getBaseOrigin() || '/';
  return withTracking ? `${url}${url.includes('?') ? '&' : '?'}ref=${QR_TRACKING_VALUE}` : url;
}

export function getPlatformName() {
  const globals = typeof globalThis !== 'undefined' ? globalThis : {};
  return String(globals.__SKAITECH_PLATFORM_NAME || 'SKAITECH').trim() || 'SKAITECH';
}

export function isQrTrackedVisit() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('ref') === QR_TRACKING_VALUE;
}

export async function recordQrScan({ scanType, agentId = null, storeSlug = null } = {}) {
  if (!isQrTrackedVisit() || !['agent_store', 'admin_system'].includes(scanType)) {
    return { skipped: true };
  }

  const pageKey = `${scanType}:${agentId || 'system'}:${window.location.pathname}`;
  try {
    const key = `skaitech_qr_scan:${pageKey}`;
    if (sessionStorage.getItem(key)) return { skipped: true, duplicate: true };
    sessionStorage.setItem(key, '1');
  } catch (_) {
    // Analytics must never block the public page if browser storage is disabled.
  }

  const { error } = await supabase.from('qr_scans').insert({
    agent_id: scanType === 'agent_store' ? agentId : null,
    scan_type: scanType,
    store_slug: scanType === 'agent_store' ? cleanSlug(storeSlug) || null : null,
    user_agent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 500) : null,
  });
  if (error) {
    console.warn('QR scan analytics notice:', error.message || error);
    return { skipped: false, error };
  }
  return { skipped: false, recorded: true };
}
