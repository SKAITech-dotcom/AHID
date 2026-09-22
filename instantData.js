import { supabase } from './supabaseClient.js';

const NETWORK_KEYS = ['mtn', 'telecel', 'airteltigo'];
const DETECT_PREFIXES = {
  mtn: ['024', '054', '055', '059', '025', '053'],
  telecel: ['020', '050'],
  airteltigo: ['027', '026', '057'],
};
const NETWORK_META = {
  mtn: { label: 'MTN', logoBg: '#ffcc00', logoColor: '#000000', text: 'MTN' },
  telecel: { label: 'Telecel', logoBg: '#dc2626', logoColor: '#ffffff', text: 'Telecel' },
  airteltigo: { label: 'AirtelTigo', logoBg: '#2563eb', logoColor: '#ffffff', text: 'AT' },
};

// Bundle catalog (sizes in MB, prices in GHS) — mirrors the public-data
// catalog enforced on the backend. Low-cost non-expiry bundles.
const BUNDLES = {
  mtn: [
    { size: '5 MB', mB: 5, price: 0.5 },
    { size: '10 MB', mB: 10, price: 1 },
    { size: '20 MB', mB: 20, price: 2 },
    { size: '30 MB', mB: 30, price: 3 },
    { size: '50 MB', mB: 50, price: 5 },
    { size: '100 MB', mB: 100, price: 10 },
    { size: '150 MB', mB: 150, price: 15 },
    { size: '200 MB', mB: 200, price: 20 },
  ],
  telecel: [
    { size: '5 MB', mB: 5, price: 0.5 },
    { size: '10 MB', mB: 10, price: 1 },
    { size: '20 MB', mB: 20, price: 2 },
    { size: '30 MB', mB: 30, price: 3 },
    { size: '50 MB', mB: 50, price: 5 },
    { size: '100 MB', mB: 100, price: 10 },
    { size: '150 MB', mB: 150, price: 15 },
    { size: '200 MB', mB: 200, price: 20 },
  ],
  airteltigo: [
    { size: '5 MB', mB: 5, price: 0.5 },
    { size: '10 MB', mB: 10, price: 1 },
    { size: '20 MB', mB: 20, price: 2 },
    { size: '30 MB', mB: 30, price: 3 },
    { size: '50 MB', mB: 50, price: 5 },
    { size: '100 MB', mB: 100, price: 10 },
    { size: '150 MB', mB: 150, price: 15 },
    { size: '200 MB', mB: 200, price: 20 },
  ],
};

let selectedNetwork = 'mtn';
let selectedBundleIndex = 0;
let checkoutBusy = false;

const $ = (id) => document.getElementById(id);

function parseUrlParam() {
  const net = new URLSearchParams(window.location.search).get('network');
  if (net && NETWORK_KEYS.includes(net.toLowerCase())) {
    selectedNetwork = net.toLowerCase();
  }
}

function detectNetworkFromPhone(phone) {
  const clean = phone.replace(/\D/g, '');
  if (clean.length < 3) return null;
  const prefix = clean.slice(0, 3);
  for (const net of NETWORK_KEYS) {
    if (DETECT_PREFIXES[net].includes(prefix)) return net;
  }
  return null;
}

export function selectDataNetwork(net) {
  if (!NETWORK_KEYS.includes(net)) return;
  selectedNetwork = net;
  selectedBundleIndex = 0;

  document.querySelectorAll('#networkGrid .id-network-btn').forEach((btn) => {
    const active = btn.dataset.network === net;
    btn.classList.toggle('active', active);
    if (active) {
      const meta = NETWORK_META[net];
      btn.style.boxShadow = `0 0 0 3px ${meta.logoBg}55, 0 4px 10px rgba(0,0,0,0.08)`;
      btn.style.borderColor = meta.logoBg;
    } else {
      btn.style.boxShadow = '';
      btn.style.borderColor = '#2a2a31';
    }
  });

  renderBundles();
  updateCheckoutBar();
}

export function handleDataPhoneInput() {
  const input = $('recipientPhone');
  let val = input.value.replace(/\D/g, '');
  if (val.length > 10) val = val.slice(0, 10);
  input.value = val;

  const hint = $('phoneNetworkHint');
  const detected = detectNetworkFromPhone(val);

  if (detected) {
    hint.className = 'id-network-hint show';
    hint.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #16a34a;"></i> ${NETWORK_META[detected].label}`;
    if (detected !== selectedNetwork && val.length >= 3) {
      selectDataNetwork(detected);
    }
  } else {
    hint.className = 'id-network-hint';
    hint.innerHTML = '';
  }

  updateCheckoutBar();
}

function renderNetworks() {
  const grid = $('networkGrid');
  grid.innerHTML = NETWORK_KEYS.map((net) => {
    const meta = NETWORK_META[net];
    return `
      <button type="button" class="id-network-btn" data-network="${net}" onclick="selectDataNetwork('${net}')">
        <span class="id-network-logo" style="background: ${meta.logoBg}; color: ${meta.logoColor};">${net === 'mtn' ? 'MTN' : net === 'telecel' ? 'T' : 'AT'}</span>
        <span>${meta.text}</span>
      </button>
    `;
  }).join('');
  selectDataNetwork(selectedNetwork);
}

function renderBundles() {
  const grid = $('bundleGrid');
  const bundles = BUNDLES[selectedNetwork];
  grid.innerHTML = bundles.map((b, i) => `
    <button type="button" class="id-bundle-row ${i === selectedBundleIndex ? 'active' : ''}" onclick="selectDataBundle(${i})">
      <span class="id-bundle-left">
        <span class="id-bundle-data-label">Data Bundle</span>
        <span class="id-bundle-size">${b.size}</span>
      </span>
      <span class="id-bundle-right">
        <span class="id-bundle-cost-label">Cost</span>
        <span class="id-bundle-price">GHS ${b.price.toFixed(2)}</span>
      </span>
    </button>
  `).join('');
}

export function selectDataBundle(index) {
  const bundles = BUNDLES[selectedNetwork];
  if (!bundles[index]) return;
  selectedBundleIndex = index;
  renderBundles();
  updateCheckoutBar();
}

function updateCheckoutBar() {
  const bundle = BUNDLES[selectedNetwork][selectedBundleIndex];
  const phone = ($('recipientPhone').value || '').trim();
  const phonePreview = phone ? { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' }[selectedNetwork] + ' ' + phone : 'Select a bundle to continue';
  $('checkoutPhone').textContent = `${NETWORK_META[selectedNetwork].text} • ${phonePreview} • ${bundle.size}`;
  $('checkoutTotal').textContent = `GHS ${bundle.price.toFixed(2)}`;
}

function showNotice(message, isError = false) {
  const notice = $('idNotice');
  notice.className = isError ? 'id-notice error' : 'id-notice info';
  notice.textContent = message;
}

function clearNotice() {
  $('idNotice').className = 'id-notice';
  $('idNotice').textContent = '';
}

function openResult(title, desc, ref, icon = '✅') {
  $('resultIcon').textContent = icon;
  $('resultTitle').textContent = title;
  $('resultDesc').textContent = desc;
  $('resultRef').textContent = ref || '-';
  $('resultOverlay').classList.add('active');
}

export function closeInstantDataResult() {
  $('resultOverlay').classList.remove('active');
}

// CHECKOUT: initializes Paystack payment (existing public-data backend).
// After payment confirmation the webhook triggers automated bundle delivery.
export async function startInstantDataCheckout() {
  if (checkoutBusy) return;

  const phone = ($('recipientPhone').value || '').trim();
  const name = ($('customerName').value || '').trim();
  const email = ($('customerEmail').value || '').trim().toLowerCase();

  if (!/^0[235]\d{8}$/.test(phone)) {
    showNotice('Enter a valid 10-digit Ghanaian recipient phone number (e.g. 024XXXXXXX).', true);
    return;
  }
  const detected = detectNetworkFromPhone(phone);
  if (detected && detected !== selectedNetwork) {
    selectDataNetwork(detected);
  }
  if (!name) {
    showNotice('Please enter the customer name for the receipt.', true);
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    showNotice('Please enter a valid email address for the payment receipt.', true);
    return;
  }

  const bundle = BUNDLES[selectedNetwork][selectedBundleIndex];
  checkoutBusy = true;
  const btn = $('buyBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing checkout...';
  clearNotice();

  try {
    const { data, error } = await supabase.functions.invoke('create-public-data-payment', {
      body: {
        name,
        email,
        phone,
        networkType: selectedNetwork,
        volumeInMB: bundle.mB,
      },
    });
    if (error) throw error;
    if (!data?.authorizationUrl) throw new Error(data?.error || 'Unable to start payment.');

    sessionStorage.setItem('skaitech_public_payment', JSON.stringify({
      reference: data.reference,
      email,
      name,
      phone,
      networkType: selectedNetwork,
      bundleSize: bundle.size,
      amount: data.netAmount,
    }));

    openResult(
      'Checkout Ready',
      'Your payment is being prepared. You will be redirected to the secure checkout to confirm.',
      data.reference,
      '⚡'
    );

    setTimeout(() => {
      window.location.href = data.authorizationUrl;
    }, 900);
  } catch (err) {
    console.warn('Instant data checkout error:', err);
    showNotice(err.message || 'Unable to start secure payment. Please try again.', true);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Buy Now';
    checkoutBusy = false;
  }
}

// RETURNING FROM PAYSTACK: verify order + show delivery status.
async function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get('reference');
  if (!reference || !String(reference).startsWith('PUB-')) return;

  const saved = JSON.parse(sessionStorage.getItem('skaitech_public_payment') || '{}');
  if (saved.reference && saved.reference !== reference) return;
  const email = saved.email || '';

  if (email) {
    const { data } = await supabase.functions.invoke('get-public-data-order', {
      body: { reference, email },
    }).catch(() => ({}));

    if (data?.order) {
      const order = data.order;
      const status = order.status;
      const icon = status === 'successful' ? '✅' : status === 'failed' ? '⚠️' : '⏳';
      const title = status === 'successful' ? 'Bundle Delivered!' : status === 'failed' ? 'Delivery Issue' : 'Processing Bundle';
      const desc = status === 'successful'
        ? 'Payment confirmed and the data bundle has been delivered to the recipient line.'
        : status === 'failed'
          ? 'Payment was received but delivery failed. Our team will follow up or refund.'
          : 'Payment received. Your bundle is still being processed and will arrive shortly.';
      const volumeGB = (order.volume_mb || 0) / 1024;

      const orders = JSON.parse(localStorage.getItem('skaitech_orders') || '[]');
      orders.unshift({
        trackingId: reference,
        network: (order.network_type || '').toUpperCase(),
        size: `${volumeGB}GB`,
        price: `GHS ${Number(order.sale_amount).toFixed(2)}`,
        name: saved.name || '',
        phone: saved.phone || '',
        status: status === 'successful' ? 'Successful' : status === 'failed' ? 'Failed' : 'Processing',
        date: new Date(order.created_at || Date.now()).toLocaleString(),
      });
      localStorage.setItem('skaitech_orders', JSON.stringify(orders));

      openResult(title, desc, reference, icon);
    } else {
      openResult('Order Status', 'We could not fetch the latest status right now. Check the Track Order page shortly.', reference, '⏳');
    }
  } else {
    openResult('Order Status', 'A return link was opened without saved checkout details.', reference, '⏳');
  }

  window.history.replaceState({}, document.title, window.location.pathname);
}

// INIT
document.addEventListener('DOMContentLoaded', () => {
  parseUrlParam();
  renderNetworks();
  renderBundles();
  updateCheckoutBar();
  handlePaymentCallback();

  // Pre-fill email from an existing session if available.
  supabase.auth.getSession().then(({ data }) => {
    if (data.session?.user?.email && !$('customerEmail').value) {
      $('customerEmail').value = data.session.user.email;
    }
  }).catch(() => {});
});

window.selectDataNetwork = selectDataNetwork;
window.handleDataPhoneInput = handleDataPhoneInput;
window.selectDataBundle = selectDataBundle;
window.startInstantDataCheckout = startInstantDataCheckout;
window.closeInstantDataResult = closeInstantDataResult;