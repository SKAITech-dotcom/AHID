import { supabase } from './supabaseClient.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

function money(value) {
  return `GHS ${Number(value || 0).toFixed(2)}`;
}

async function loadReferrals() {
  const history = document.getElementById('referralHistory');
  try {
    const { data, error } = await supabase.functions.invoke('manage-agent-referrals', { method: 'GET' });
    if (error || !data?.success) throw new Error(error?.message || data?.error || 'Unable to load referrals.');

    document.getElementById('referralLink').value = data.referralLink || 'Referral link unavailable';
    document.getElementById('referralCode').textContent = data.referralCode || '—';
    document.getElementById('referralCount').textContent = String(data.count || 0);
    document.getElementById('referralRewardTotal').textContent = money(data.rewardTotal);

    const rows = Array.isArray(data.referrals) ? data.referrals : [];
    if (!rows.length) {
      history.innerHTML = '<div class="referral-empty">No qualified referrals yet. Share your link to get started.</div>';
      return;
    }
    history.innerHTML = `<table class="referral-table"><thead><tr><th>Status</th><th>Source</th><th>Date</th></tr></thead><tbody>${rows.map((row) => `
      <tr><td>${escapeHtml(row.status || 'qualified')}</td><td>${escapeHtml(row.source || 'signup')}</td><td>${escapeHtml(row.created_at ? new Date(row.created_at).toLocaleString() : '—')}</td></tr>
    `).join('')}</tbody></table>`;
  } catch (error) {
    console.error('loadReferrals failed:', error);
    history.textContent = error.message || 'Unable to load referral history.';
  }
}

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
