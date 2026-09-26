import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';
import { applyWalletBalance, refreshWalletBalance } from './walletBalance.js';

const PRICES = { BECE: 19, WASSCE: 22, 'NOV/DEC': 22 };
const $ = (id) => document.getElementById(id);
function notice(message, isError = false) { const el = $('notice'); el.textContent = message; el.className = `notice show${isError ? ' error' : ''}`; }
function updatePrice() { const price = PRICES[$('examType').value]; const quantity = Math.max(1, Number.parseInt($('quantity').value, 10) || 1); $('quantity').value = quantity; $('pricePerPin').textContent = price.toFixed(2); $('totalPrice').textContent = (price * quantity).toFixed(2); }

async function showCompletedOrder(reference) {
  const saved = JSON.parse(sessionStorage.getItem('skaitech_result_payment') || '{}');
  if (saved.reference !== reference || !saved.email) { notice('Payment received. Keep your reference and contact support to retrieve your PIN.'); return; }
  const { data, error } = await supabase.functions.invoke('get-result-checker-order', { body: { reference, email: saved.email } });
  if (error || data?.error) { notice(data?.error || 'Unable to retrieve your order.', true); return; }
  if (data.order.status !== 'paid') { notice('Your payment is being confirmed. Refresh in a few seconds; do not pay again.'); return; }
  $('pins').textContent = `Payment confirmed. Save these PIN details:\n${data.order.pins.map((pin) => `PIN: ${pin.pin}${pin.serial ? ` | SERIAL: ${pin.serial}` : ''}`).join('\n')}`;
  $('pins').hidden = false;
  notice(`Order ${reference} is complete.`);
}

$('resultsCheckerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  notice('Checking agent wallet balance…');

  const { isAgent } = await checkAgentAccessServer();
  if (!isAgent) {
    notice('Results checker purchases are available only to verified Skaitech Agents. Please sign in as an agent.', true);
    button.disabled = false;
    return;
  }

  const email = $('email').value.trim().toLowerCase();
  const phone = $('phoneNumber').value.trim();

  notice('Charging your agent wallet and confirming PIN stock…');
  const { data, error } = await supabase.functions.invoke('create-result-checker-payment', {
    body: { examType: $('examType').value, quantity: Number($('quantity').value), email, phone },
  });

  if (error || data?.error) {
    notice(data?.error || 'Unable to process your purchase.', true);
    button.disabled = false;
    return;
  }

  sessionStorage.setItem('skaitech_result_payment', JSON.stringify({ reference: data.reference, email }));
  if (Number.isFinite(Number(data.walletBalance))) applyWalletBalance(data.walletBalance);

  $('pins').textContent = `Payment confirmed from your agent wallet. Save these PIN details:\n${data.pins.map((pin) => `PIN: ${pin.pin}${pin.serial ? ` | SERIAL: ${pin.serial}` : ''}`).join('\n')}`;
  $('pins').hidden = false;
  notice(data.message || `Order ${data.reference} is complete. Wallet balance updated.`);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => refreshWalletBalance());
} else {
  refreshWalletBalance();
}

$('examType').addEventListener('change', updatePrice);
$('quantity').addEventListener('input', updatePrice);
updatePrice();
const reference = new URLSearchParams(window.location.search).get('reference');
if (reference) showCompletedOrder(reference);