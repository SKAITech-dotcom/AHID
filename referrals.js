import { supabase } from './supabaseClient.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

function money(value) {
  return `GHS ${Number(value || 0).toFixed(2)}`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function loadReferrals() {
  const history = document.getElementById('referralHistory');
  try {
    const { data, error } = await supabase.functions.invoke('manage-agent-referrals', { method: 'GET' });
    if (error || !data?.success) throw new Error(error?.message || data?.error || 'Unable to load referrals.');

    document.getElementById('referralLink').value = data.referralLink || 'Referral link unavailable';
    document.getElementById('referralCode').textContent = data.referralSlug || data.referralCode || '—';
    setText('referralCount', String(data.count || 0));
    setText('referralRewardTotal', money(data.rewardTotal));
    setText('referralBalance', money(data.referralBalance));
    setText('referralAvailableInline', money(data.referralBalance));
    setText('referralSettledTotal', money(Number(data.transferredReferralRewards || 0) + Number(data.paidReferralRewards || 0)));

    const rows = Array.isArray(data.referrals) ? data.referrals : [];
    if (!rows.length) {
      history.innerHTML = '<div class="referral-empty">No qualified referrals yet. Share your link to get started.</div>';
      return;
    }
    history.innerHTML = `<table class="referral-table"><thead><tr><th>Referred account</th><th>Status</th><th>Reward</th><th>Payment / audit</th><th>Date</th></tr></thead><tbody>${rows.map((row) => {
      const referred = row.referredAgent || {};
      const award = row.award || {};
      const awardStatus = award.status || 'Not rewarded';
      const audit = award.audit_reference ? `${award.audit_reference}${award.paid_reference ? ` · Paid: ${award.paid_reference}` : ''}` : '—';
      return `
      <tr><td><strong>${escapeHtml(referred.full_name || 'New account')}</strong><br><small>${escapeHtml(referred.phone || referred.agent_code || '—')}</small></td><td><span class="referral-status">${escapeHtml(row.status || 'qualified')} · ${escapeHtml(row.source || 'signup')}</span></td><td>${award.amount ? money(award.amount) : '—'}</td><td>${escapeHtml(awardStatus)}<br><small>${escapeHtml(audit)}</small></td><td>${escapeHtml(row.created_at ? new Date(row.created_at).toLocaleString() : '—')}</td></tr>`;
    }).join('')}</tbody></table>`;
  } catch (error) {
    console.error('loadReferrals failed:', error);
    history.textContent = error.message || 'Unable to load referral history.';
  }
}

document.getElementById('transferReferralBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('referralTransferAmount');
  const amount = Number(input?.value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const button = document.getElementById('transferReferralBtn');
  if (button) { button.disabled = true; button.textContent = 'Transferring…'; }
  try {
    const { data, error } = await supabase.functions.invoke('manage-agent-referrals', { body: { action: 'transfer', amount } });
    if (error || !data?.success) throw new Error(error?.message || data?.error || 'Referral transfer failed.');
    if (input) input.value = '';
    await loadReferrals();
  } catch (error) {
    console.error('transferReferralRewards failed:', error);
    window.alert(error.message || 'Referral transfer failed.');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-right-left"></i> Transfer to Main Account'; }
  }
});

document.getElementById('copyReferralBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('referralLink');
  if (!input?.value || input.value.includes('unavailable')) return;
  try {
    await navigator.clipboard.writeText(input.value);
    const button = document.getElementById('copyReferralBtn');
    button.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
    setTimeout(() => { button.innerHTML = '<i class="fa-solid fa-copy"></i> Copy link'; }, 1800);
  } catch (_) {
    input.select();
    document.execCommand('copy');
  }
});

loadReferrals();
