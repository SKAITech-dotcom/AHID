import { supabase } from './supabaseClient.js';

const notice = document.getElementById('notice');
const requestList = document.getElementById('requests');
let currentStatus = 'pending';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

async function loadRequests() {
  requestList.textContent = 'Loading requests…';
  const { data, error } = await supabase.functions.invoke('manage-cashout-deposits', { body: { action: 'list', status: currentStatus } });
  if (error || data?.error) {
    requestList.textContent = '';
    notice.textContent = data?.error || error?.message || 'Unable to load requests. Administrator access is required.';
    return;
  }
  notice.textContent = '';
  if (!data.requests?.length) {
    requestList.textContent = 'No requests found.';
    return;
  }
  requestList.innerHTML = data.requests.map((entry) => {
    const agent = Array.isArray(entry.agents) ? entry.agents[0] : entry.agents;
    const agentName = agent?.full_name || agent?.agent_code || entry.agent_id;
    const controls = entry.status === 'pending'
      ? `<div style="display:flex; gap:8px; margin-top:12px;"><button type="button" data-approve="${entry.id}">Approve</button><button type="button" data-reject="${entry.id}">Reject</button></div>`
      : '';
    return `<article style="border:1px solid #e5e7eb; border-radius:8px; padding:16px; margin:12px 0;">
      <strong>${escapeHtml(agentName)}</strong> — GHS ${Number(entry.amount).toFixed(2)}<br>
      Payer: ${escapeHtml(entry.payer_phone)} • ${escapeHtml(entry.status)} • ${new Date(entry.requested_at).toLocaleString()}<br>
      ${entry.settlement_reference ? `Settlement reference: ${escapeHtml(entry.settlement_reference)}<br>` : ''}
      ${entry.admin_note ? `Note: ${escapeHtml(entry.admin_note)}<br>` : ''}${controls}
    </article>`;
  }).join('');
}

async function review(requestId, decision) {
  const settlementReference = decision === 'approve' ? window.prompt('Verified MoMo settlement reference:') : '';
  if (decision === 'approve' && !settlementReference?.trim()) return;
  const note = window.prompt('Optional admin note:') || '';
  const { data, error } = await supabase.functions.invoke('manage-cashout-deposits', {
    body: { action: 'review', requestId, decision, settlementReference, note },
  });
  if (error || data?.error) {
    notice.textContent = data?.error || error?.message || 'Unable to review the request.';
    return;
  }
  notice.textContent = `Request ${data.request.status}.`;
  loadRequests();
}

document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
  currentStatus = button.dataset.status;
  loadRequests();
}));
requestList.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button?.dataset.approve) review(button.dataset.approve, 'approve');
  if (button?.dataset.reject) review(button.dataset.reject, 'reject');
});

loadRequests();
