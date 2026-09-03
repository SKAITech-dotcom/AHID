document.addEventListener('DOMContentLoaded', () => {
    // 1. Load Wallet Balance
    const balanceEl = document.getElementById('walletPageBalance');
    const currentBalance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    if (balanceEl) {
        balanceEl.innerText = `GHS ${currentBalance.toFixed(2)}`;
    }

    // 2. Render Agent Initials (e.g. "Seidu Mobiri" -> "SM")
    const initialsEl = document.getElementById('walletAgentInitials');
    if (initialsEl) {
        const storedName = localStorage.getItem('agent_name') || 'Seidu Mobiri';
        const parts = storedName.trim().split(' ');
        let initials = 'SA';
        if (parts.length >= 2) {
            initials = (parts[0][0] + parts[1][0]).toUpperCase();
        } else if (parts.length === 1 && parts[0].length > 0) {
            initials = parts[0].substring(0, 2).toUpperCase();
        }
        initialsEl.innerText = initials;
    }

    // 3. Load & Render Transactions
    renderTransactions();
});

function expressPayDeposit() {
    const amt = prompt('Enter amount to deposit via ExpressPay (GHS):');
    if (!amt || isNaN(amt) || parseFloat(amt) <= 0) return;

    let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    balance += parseFloat(amt);
    localStorage.setItem('agent_wallet_balance', balance);

    // Save transaction
    let txs = JSON.parse(localStorage.getItem('agent_transactions')) || [];
    txs.unshift({
        id: 'TXN-' + Math.floor(100000 + Math.random() * 900000),
        type: 'DEPOSIT',
        amount: `+GHS ${parseFloat(amt).toFixed(2)}`,
        date: new Date().toLocaleDateString()
    });
    localStorage.setItem('agent_transactions', JSON.stringify(txs));

    alert(`Successfully deposited GHS ${parseFloat(amt).toFixed(2)}!`);
    location.reload();
}

function directDepositInfo() {
    alert('Direct Deposit Instructions:\nSend funds to MTN MoMo: 0559388178 (Skaitech Ltd) and contact support with your reference.');
}

function renderTransactions() {
    const listContainer = document.getElementById('transactionResultsList');
    const txs = JSON.parse(localStorage.getItem('agent_transactions')) || [];

    if (txs.length === 0) {
        listContainer.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 0.9rem; padding: 30px 0;">No transactions found.</div>`;
        return;
    }

    let html = '';
    txs.forEach(tx => {
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