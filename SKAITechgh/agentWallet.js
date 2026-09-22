import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 0. Enforce verified agent authentication
    const authResult = await requireVerifiedAgent({ redirectOnFail: true });
    if (!authResult) return;

    // 1. Load Wallet Balance from DB
    const balanceEl = document.getElementById('walletPageBalance');
    let currentBalance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    try {
        const { data: wallet } = await supabase.from('wallets').select('balance').eq('id', authResult.user.id).single();
        if (wallet && wallet.balance !== null) {
            currentBalance = parseFloat(wallet.balance);
            localStorage.setItem('agent_wallet_balance', currentBalance);
        }
    } catch (err) {
        console.warn('Could not fetch remote wallet balance:', err);
    }
    if (balanceEl) {
        balanceEl.innerText = `GHS ${currentBalance.toFixed(2)}`;
    }

    // 2. Render Agent Initials
    const initialsEl = document.getElementById('walletAgentInitials');
    if (initialsEl) {
        const storedName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || 'Valued Agent';
        const parts = storedName.trim().split(/\s+/);
        let initials = 'SA';
        if (parts.length >= 2) {
            initials = (parts[0][0] + parts[1][0]).toUpperCase();
        } else if (parts.length === 1 && parts[0].length > 0) {
            initials = parts[0].substring(0, 2).toUpperCase();
        }
        initialsEl.innerText = initials;
    }

    // 3. Attach Filter Listeners
    const typeFilter = document.getElementById('txTypeFilter');
    const idFilter = document.getElementById('txIdFilter');
    if (typeFilter) typeFilter.addEventListener('change', () => renderTransactions());
    if (idFilter) idFilter.addEventListener('input', () => renderTransactions());

    // 4. Load & Render Transactions
    renderTransactions();
});

async function expressPayDeposit() {
    const amt = prompt('Enter amount to deposit via ExpressPay (GHS):');
    if (!amt || isNaN(amt) || parseFloat(amt) <= 0) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        alert('Please sign in with your agent account before funding your wallet.');
        window.location.href = 'login.html';
        return;
    }

    try {
        const { data, error } = await supabase.functions.invoke('create-agent-wallet-payment', {
            body: { amount: parseFloat(amt) }
        });
        if (error) throw error;
        if (!data?.authorizationUrl) throw new Error(data?.error || 'Unable to open checkout.');
        window.location.href = data.authorizationUrl;
    } catch (error) {
        alert(error.message || 'Unable to start secure payment. Please try again.');
    }
}

function directDepositInfo() {
    alert('Direct Deposit Instructions:\nSend funds to MTN MoMo: 0559388178 (Skaitech Ltd) and contact support with your reference.');
}

function renderTransactions() {
    const listContainer = document.getElementById('transactionResultsList');
    if (!listContainer) return;
    const txs = JSON.parse(localStorage.getItem('agent_transactions')) || [];

    const typeFilter = document.getElementById('txTypeFilter')?.value || 'All';
    const idFilter = document.getElementById('txIdFilter')?.value.trim().toLowerCase() || '';

    const filtered = txs.filter(tx => {
        const typeMatch = (typeFilter === 'All') || (tx.type && tx.type.toUpperCase() === typeFilter.toUpperCase());
        const idMatch = !idFilter || (tx.id && tx.id.toLowerCase().includes(idFilter));
        return typeMatch && idMatch;
    });

    if (filtered.length === 0) {
        listContainer.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 0.9rem; padding: 30px 0;">No transactions found.</div>`;
        return;
    }

    let html = '';
    filtered.forEach(tx => {
        html += `
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f1f5f9;">
                <div>
                    <div style="font-weight: 700; font-size: 0.9rem; color: #1e293b;">${tx.type} (${tx.id || 'REF'})</div>
                    <div style="font-size: 0.75rem; color: #64748b;">${tx.date}</div>
                </div>
                <div style="font-weight: 800; font-size: 0.95rem; color: ${tx.type === 'DEPOSIT' ? '#10b981' : '#ef4444'};">${tx.amount}</div>
            </div>
        `;
    });
    listContainer.innerHTML = html;
}

// Bind agent wallet functions to window for HTML onclick attributes
window.expressPayDeposit = expressPayDeposit;
window.directDepositInfo = directDepositInfo;
window.renderTransactions = renderTransactions;