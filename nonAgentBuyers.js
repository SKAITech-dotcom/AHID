import { supabase, readFunctionError } from './supabaseClient.js';

const NETWORKS = ['mtn', 'telecel', 'airteltigo'];
const NETWORK_LABELS = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };
const params = new URLSearchParams(window.location.search);
let network = NETWORKS.includes(params.get('network')) ? params.get('network') : 'mtn';
let bundles = [];
let selectedBundle = null;
let guestOrders = [];
const GUEST_ORDER_HISTORY_KEY = 'skaitech_guest_data_orders';

const $ = (id) => document.getElementById(id);
const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const volume = (mb) => Number(mb) >= 1024 ? `${Number(mb) / 1024 % 1 ? (Number(mb) / 1024).toFixed(1) : Number(mb) / 1024}GB` : `${mb}MB`;
const paymentGatewayForPrice = (price) => Number(price) >= 10 && Number(price) <= 50 ? 'Paystack' : 'Skaipay';

function showMessage(text, type = 'info') {
  const element = $('message');
  if (!element) return;
  element.textContent = text;
  element.className = `message show ${type}`;
}

function persistGuestOrders() {
  try {
    localStorage.setItem(GUEST_ORDER_HISTORY_KEY, JSON.stringify(guestOrders.slice(0, 10)));
  } catch (error) {
    console.warn('Unable to save guest order history:', error);
  }
}

function rememberGuestOrder(order) {
  const next = {
    orderCode: String(order.orderCode || '').trim().toUpperCase(),
    reference: String(order.reference || '').trim(),
    accessToken: String(order.accessToken || '').trim(),
    phone: String(order.phone || '').trim(),
    status: String(order.status || 'pending_payment'),
    updatedAt: new Date().toISOString(),
  };
  if (!next.orderCode && !next.reference) return;
  guestOrders = [next, ...guestOrders.filter((item) => (
    next.orderCode ? item.orderCode !== next.orderCode : item.reference !== next.reference
  ))].slice(0, 10);
  persistGuestOrders();
  renderGuestOrders();
}

function renderGuestOrders() {
  const list = $('ordersList');
  if (!list) return;
  if (!guestOrders.length) {
    list.innerHTML = '<div class="orders-empty">Your recent guest orders will appear here.</div>';
    return;
  }
  list.innerHTML = guestOrders.map((item, index) => {
    const status = String(item.status || 'pending_payment').replaceAll('_', ' ');
    return `<article class="order-item">
      <strong>Order ${escapeHtml(item.orderCode || '—')}</strong>
      <div class="order-meta">Recipient: ${escapeHtml(item.phone || '—')}</div>
      <div class="order-state">${escapeHtml(status)}</div>
      <button type="button" data-refresh-order="${index}">Refresh status</button>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-refresh-order]').forEach((button) => button.addEventListener('click', () => {
    refreshGuestOrder(Number(button.dataset.refreshOrder), button);
  }));
}

function loadGuestOrderHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_ORDER_HISTORY_KEY) || '[]');
    guestOrders = Array.isArray(parsed) ? parsed.filter((item) => item && (item.orderCode || item.reference)) : [];
  } catch {
    guestOrders = [];
  }
  renderGuestOrders();
}

function renderTabs() {
  $('networkTabs').innerHTML = NETWORKS.map((key) => `<button class="network-tab ${key === network ? 'active' : ''}" data-network="${key}" type="button">${NETWORK_LABELS[key]}</button>`).join('');
  $('networkTabs').querySelectorAll('[data-network]').forEach((button) => button.addEventListener('click', () => {
    network = button.dataset.network;
    const url = new URL(window.location.href);
    url.searchParams.set('network', network);
    window.history.replaceState({}, '', url);
    renderTabs();
    renderBundles();
  }));
}

function renderBundles() {
  const visible = bundles.filter((bundle) => String(bundle.network).toLowerCase() === network);
  const catalog = $('catalog');
  if (!visible.length) {
    catalog.innerHTML = '<div class="message show info">No bundles are currently available on this network.</div>';
    return;
  }
  catalog.innerHTML = visible.map((bundle) => `
    <article class="bundle">
      <h2>${escapeHtml(volume(bundle.volumeMb))}</h2>
      <small>${escapeHtml(bundle.title || `${NETWORK_LABELS[network]} data bundle`)}${bundle.validity ? ` · ${escapeHtml(bundle.validity)}` : ''}</small>
      <div class="price">${money(bundle.price)}</div>
      <button class="buy" type="button" data-bundle-id="${escapeHtml(bundle.bundleId)}">Buy this bundle</button>
    </article>`).join('');
  catalog.querySelectorAll('[data-bundle-id]').forEach((button) => button.addEventListener('click', () => openCheckout(button.dataset.bundleId)));
}

function openCheckout(bundleId) {
  selectedBundle = bundles.find((bundle) => bundle.bundleId === bundleId) || null;
  if (!selectedBundle) return;
  $('selectedBundle').textContent = `${NETWORK_LABELS[selectedBundle.network]} · ${volume(selectedBundle.volumeMb)} · ${money(selectedBundle.price)}`;
  $('paymentHelp').textContent = `Complete the ${paymentGatewayForPrice(selectedBundle.price)} checkout. Your bundle is sent after payment is confirmed.`;
  $('checkout').classList.add('open');
  $('customerPhone').focus();
  $('checkout').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeCheckout() {
  selectedBundle = null;
  $('checkout').classList.remove('open');
  $('customerPhone').value = '';
}

async function loadCatalog() {
  try {
    const { data, error } = await supabase.functions.invoke('public-data-catalog', { body: {} });
    if (error) {
      const details = await readFunctionError(error);
      throw new Error(details.message || 'Unable to load the live data catalogue.');
    }
    bundles = Array.isArray(data?.bundles) ? data.bundles : [];
    renderTabs();
    renderBundles();
    if (!bundles.length) showMessage('No data bundles are available right now.', 'info');
  } catch (error) {
    console.error(error);
    $('catalog').innerHTML = '';
    showMessage(error.message || 'Unable to load data bundles. Please refresh and try again.', 'error');
  }
}

async function startCheckout() {
  if (!selectedBundle) return showMessage('Choose a data bundle first.', 'error');
  const phone = $('customerPhone').value.trim();
  if (!/^0\d{9}$/.test(phone)) return showMessage('Enter a valid 10-digit Ghana customer number.', 'error');

  const button = $('payButton');
  button.disabled = true;
  button.textContent = 'Starting secure checkout…';
  showMessage('Preparing your secure payment…', 'info');
  try {
    const { data, error } = await supabase.functions.invoke('create-public-data-checkout', {
      body: { bundleId: selectedBundle.bundleId, phone },
    });
    if (error) {
      const details = await readFunctionError(error);
      throw new Error(details.message || 'Unable to start checkout.');
    }
    if (!data?.authorizationUrl || !data.reference || !data.accessToken) throw new Error(data?.error || 'The payment gateway did not return a checkout link.');
    sessionStorage.setItem('skaitech_guest_data_payment', JSON.stringify({
      reference: data.reference,
      accessToken: data.accessToken,
      orderCode: data.orderCode || '',
      phone,
      bundleId: selectedBundle.bundleId,
    }));
    rememberGuestOrder({
      reference: data.reference,
      accessToken: data.accessToken,
      orderCode: data.orderCode,
      phone,
      status: 'pending_payment',
    });
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    console.error(error);
    showMessage(error.message || 'Unable to start checkout. Please try again.', 'error');
    button.disabled = false;
    button.textContent = 'Continue to payment';
  }
}

async function getOrderStatus(payment) {
  const { data, error } = await supabase.functions.invoke('get-public-data-order', {
    body: {
      reference: payment.reference,
      orderCode: payment.orderCode,
      accessToken: payment.accessToken,
      phone: payment.phone,
    },
  });
  if (error) {
    const details = await readFunctionError(error);
    throw new Error(details.message || 'Unable to read order status.');
  }
  return data?.order || null;
}

async function refreshGuestOrder(index, button) {
  const payment = guestOrders[index];
  if (!payment) return;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const order = await getOrderStatus(payment);
    if (!order) throw new Error('Order was not found. Check the order ID and recipient number.');
    payment.orderCode = String(order.short_code || payment.orderCode || '').toUpperCase();
    payment.status = String(order.status || 'processing');
    payment.updatedAt = new Date().toISOString();
    persistGuestOrders();
    renderGuestOrders();
  } catch (error) {
    showMessage(error.message || 'Unable to refresh this order.', 'error');
    button.disabled = false;
    button.textContent = 'Refresh status';
  }
}

async function trackGuestOrder() {
  const code = $('orderCodeInput').value.trim().toUpperCase();
  const phone = $('orderPhoneInput').value.trim();
  if (!/^[A-Z0-9]{5}$/.test(code)) return showMessage('Enter the 5-character order ID.', 'error');
  if (!/^0\d{9}$/.test(phone)) return showMessage('Enter the valid 10-digit Ghana recipient number.', 'error');
  const button = $('trackOrderButton');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const order = await getOrderStatus({ orderCode: code, phone });
    if (!order) throw new Error('Order was not found. Check the order ID and recipient number.');
    rememberGuestOrder({ orderCode: order.short_code || code, phone, status: order.status || 'processing' });
    showMessage(`Order ${order.short_code || code} is ${String(order.status || 'processing').replaceAll('_', ' ')}.`, 'success');
  } catch (error) {
    showMessage(error.message || 'Unable to track this order.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Track order';
  }
}

async function verifyPayment(payment) {
  const { data, error } = await supabase.functions.invoke('verify-public-data-payment', { body: { reference: payment.reference } });
  if (error) {
    const details = await readFunctionError(error);
    throw new Error(details.message || 'Payment verification is still processing.');
  }
  return data || {};
}

async function showPaymentResult() {
  const reference = params.get('reference');
  if (!reference) return;
  const payment = JSON.parse(sessionStorage.getItem('skaitech_guest_data_payment') || '{}');
  if (payment.reference !== reference) {
    showMessage('Payment reference found, but this browser has no matching checkout session. Use Track Order with your order code.', 'error');
    return;
  }
  $('statusCard').classList.add('show');
  $('statusText').textContent = 'Confirming payment and sending your bundle…';
  $('statusReference').textContent = payment.orderCode ? `Order ID: ${payment.orderCode}` : 'Your 5-character order ID is being prepared…';
  try { await verifyPayment(payment); } catch (error) { console.warn(error.message); }

  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const order = await getOrderStatus(payment);
      if (order?.short_code && !payment.orderCode) {
        payment.orderCode = order.short_code;
        rememberGuestOrder({ ...payment, status: order.status });
        $('statusReference').textContent = `Order ID: ${payment.orderCode}`;
      }
      const state = String(order?.status || 'pending_payment').toLowerCase();
      if (state === 'successful') {
        $('statusText').textContent = `Bundle delivered to ${payment.phone}. Keep your 5-character order ID for tracking.`;
        $('statusText').style.color = '#065f46';
        return;
      }
      if (state === 'failed' || state === 'cancelled') {
        $('statusText').textContent = 'This bundle could not be delivered. Please contact support about the payment refund.';
        $('statusText').style.color = '#991b1b';
        return;
      }
      $('statusText').textContent = state === 'pending_payment' ? 'Payment is still being confirmed…' : 'Payment confirmed. Your bundle is being delivered…';
      if (attempts < 12) window.setTimeout(poll, 5000);
    } catch (error) {
      if (attempts < 12) window.setTimeout(poll, 5000);
      else $('statusText').textContent = error.message || 'Unable to read order status. Please use Track Order.';
    }
  };
  poll();
}

$('payButton').addEventListener('click', startCheckout);
$('cancelButton').addEventListener('click', closeCheckout);
$('trackOrderButton').addEventListener('click', trackGuestOrder);
loadGuestOrderHistory();
loadCatalog();
showPaymentResult();
