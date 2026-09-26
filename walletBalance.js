import { supabase } from './supabaseClient.js';

/**
 * Applies a server-returned wallet balance to localStorage and every visible
 * wallet-balance element (so the UI updates without a manual refresh).
 */
export function applyWalletBalance(balance) {
  const value = Number(balance) || 0;
  localStorage.setItem('agent_wallet_balance', value.toFixed(2));

  document.querySelectorAll('.wallet-balance, [data-wallet-balance]').forEach((el) => {
    el.textContent = value.toFixed(2);
  });

  ['agentBannerBalance', 'walletPageBalance'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value.toFixed(2);
  });

  const subtitle = document.getElementById('walletCardSubtitle');
  if (subtitle) subtitle.textContent = `Balance: GHS ${value.toFixed(2)}`;
}

/**
 * Fetches the current signed-in wallet balance from the wallets table
 * (RLS allows an agent to read their own row) and applies it to the page.
 */
export async function refreshWalletBalance() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return null;
    const { data } = await supabase
      .from('wallets')
      .select('balance')
      .eq('id', session.user.id)
      .maybeSingle();
    const balance = Number(data?.balance ?? 0);
    applyWalletBalance(balance);
    return balance;
  } catch (err) {
    console.warn('Could not refresh wallet balance:', err);
    return null;
  }
}