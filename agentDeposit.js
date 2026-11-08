import { supabase, readFunctionError } from './supabaseClient.js';

let selectedWalletProvider = 'paystack';

// Load and display current wallet balance on page load
document.addEventListener('DOMContentLoaded', () => {
    updateWalletDisplay();
    handlePaymentReturn();
    initializeWalletModal();
    if (!new URLSearchParams(window.location.search).has('reference')) {
        openLoadWalletModal();
    }
});

async function updateWalletDisplay() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    const { data: wallet, error } = await supabase
        .from('wallets')
        .select('balance')
        .eq('id', user.id)
        .maybeSingle();
    const balance = !error && wallet ? Number(wallet.balance) || 0 : 0;

    if (!error && wallet) {
        localStorage.setItem('agent_wallet_balance', String(balance));
    }

    const balanceDisplay = document.getElementById('walletHeaderDisplay');
    if (balanceDisplay) {
        balanceDisplay.innerText = `Available Balance: GHS ${balance.toFixed(2)}`;
    }
}

function walletAmount() {
    const value = Number.parseFloat(document.getElementById('expressAmount')?.value || '0');
    return Number.isFinite(value) ? value : 0;
}

function updateWalletPayButton() {
    const button = document.getElementById('loadWalletPayBtn');
    if (!button || button.disabled) return;
    const amount = walletAmount();
    button.textContent = amount > 0
        ? `Pay GH₵ ${amount.toFixed(2)}`
        : 'Enter Amount';
}

function closeLoadWalletModal() {
    const modal = document.getElementById('loadWalletModal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('wallet-modal-open');
}

function openLoadWalletModal() {
    const modal = document.getElementById('loadWalletModal');
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('wallet-modal-open');
    updateWalletPayButton();
    window.setTimeout(() => document.getElementById('expressAmount')?.focus(), 50);
}

function selectWalletProvider(provider) {
    selectedWalletProvider = String(provider).toLowerCase() === 'hubtel' ? 'hubtel' : 'paystack';
    document.querySelectorAll('.gateway-option[data-provider]').forEach((option) => {
        const isSelected = option.dataset.provider === selectedWalletProvider;
        option.classList.toggle('is-selected', isSelected);
        option.setAttribute('aria-pressed', String(isSelected));
    });
}

function chooseWalletAmount(amount) {
    const input = document.getElementById('expressAmount');
    if (!input) return;
    input.value = amount;
    document.querySelectorAll('.quick-amount[data-amount]').forEach((chip) => {
        chip.classList.toggle('is-selected', Number(chip.dataset.amount) === Number(amount));
    });
    updateWalletPayButton();
}

function initializeWalletModal() {
    document.getElementById('closeLoadWalletBtn')?.addEventListener('click', closeLoadWalletModal);
    document.getElementById('cancelLoadWalletBtn')?.addEventListener('click', closeLoadWalletModal);
    document.querySelector('[data-close-wallet-modal]')?.addEventListener('click', closeLoadWalletModal);
    document.getElementById('expressAmount')?.addEventListener('input', () => {
        document.querySelectorAll('.quick-amount[data-amount]').forEach((chip) => {
            chip.classList.toggle('is-selected', Number(chip.dataset.amount) === walletAmount());
        });
        updateWalletPayButton();
    });
    document.querySelectorAll('.quick-amount[data-amount]').forEach((chip) => {
        chip.addEventListener('click', () => chooseWalletAmount(chip.dataset.amount));
    });
    document.querySelectorAll('.gateway-option[data-provider]').forEach((option) => {
        option.addEventListener('click', () => selectWalletProvider(option.dataset.provider));
    });
    document.getElementById('loadWalletForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        payWithExpressPay(selectedWalletProvider);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !document.getElementById('loadWalletModal')?.hidden) closeLoadWalletModal();
    });
}

async function verifyWalletTopup(reference) {
    const { data, error } = await supabase.functions.invoke('verify-wallet-topup', {
        body: { reference },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
}

function wait(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function fetchWalletTopup(reference) {
    const { data, error } = await supabase
        .from('wallet_topups')
        .select('amount, status, provider, payment_reference')
        .eq('payment_reference', reference)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function handlePaymentReturn() {
    const reference = new URLSearchParams(window.location.search).get('reference');
    const statusElement = document.getElementById('walletPaymentStatus');
    if (!reference || !statusElement) return;

    statusElement.hidden = false;
    statusElement.textContent = 'Payment received. Confirming your wallet top-up...';

    let topup;
    try {
        topup = await fetchWalletTopup(reference);
    } catch (error) {
        console.warn('Could not load the returned wallet top-up:', error);
    }

    if (!topup) {
        statusElement.textContent = 'Payment submitted. Your wallet will update after the payment provider confirms the transaction.';
        return;
    }

    let verification = null;
    // Hubtel may redirect the browser before its server callback has finished.
    // Keep checking for up to 30 seconds so the agent sees the credit without
    // needing to refresh or leave the wallet flow manually.
    for (let attempt = 0; attempt < 15; attempt += 1) {
        if (topup?.status === 'paid') {
            verification = { credited: true };
            break;
        }
        if (topup?.status === 'failed') break;

        try {
            verification = await verifyWalletTopup(reference);
            if (verification?.credited === true || verification?.status === 'failed') break;
        } catch (verifyError) {
            console.warn('Wallet top-up verification is still pending:', verifyError);
        }

        if (attempt < 14) await wait(2000);
        try {
            topup = await fetchWalletTopup(reference);
        } catch (refreshError) {
            console.warn('Could not refresh wallet top-up status:', refreshError);
        }
    }

    if (verification?.credited === true) {
        const creditedAmount = Number(topup?.amount ?? verification.amount ?? 0);
        statusElement.textContent = `Wallet loaded successfully: GHS ${creditedAmount.toFixed(2)}.`;
        await updateWalletDisplay();
        window.setTimeout(() => {
            const amount = encodeURIComponent(creditedAmount.toFixed(2));
            window.location.replace(`agentWallet.html?deposit=success&amount=${amount}`);
        }, 1200);
        return;
    }

    if (topup?.status === 'failed' || verification?.status === 'failed') {
        statusElement.textContent = 'Payment was not successful. Your wallet was not loaded.';
        return;
    }

    statusElement.textContent = 'Payment is still being confirmed. Your wallet has not been loaded yet.';
}

// Paystack and Hubtel Checkout Handler
async function payWithExpressPay(provider = 'paystack') {
    const selectedProvider = String(provider).toLowerCase() === 'hubtel' ? 'hubtel' : 'paystack';
    const amountInput = document.getElementById('expressAmount');
    const amount = parseFloat(amountInput ? amountInput.value : 0);

    if (!amount || amount <= 0) {
        alert("Please enter a valid deposit amount in GHS.");
        return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        alert('Please sign in with your agent account before funding your wallet.');
        window.location.href = 'login.html';
        return;
    }

    const button = document.getElementById('loadWalletPayBtn');
    const providerLabel = selectedProvider === 'hubtel' ? 'Skaipay' : 'Paystack';
    if (button) {
        button.disabled = true;
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Opening ${providerLabel} checkout…`;
    }

    try {
        const { data, error } = await supabase.functions.invoke('create-agent-wallet-payment', {
            body: { amount, provider: selectedProvider }
        });
        if (error) {
            const details = await readFunctionError(error);
            throw new Error(details.message || `Unable to open ${providerLabel} checkout.`);
        }
        if (!data?.authorizationUrl) throw new Error(data?.error || `Unable to open ${providerLabel} checkout.`);
        const checkoutUrl = String(data.authorizationUrl).trim();
        if (!/^https?:\/\//i.test(checkoutUrl)) throw new Error(`Invalid ${providerLabel} checkout URL.`);
        // Explicit same-tab navigation; do not open a second browser tab/window.
        window.location.replace(checkoutUrl);
    } catch (error) {
        alert(error.message || `Unable to start ${providerLabel} payment. Please try again.`);
        if (button) {
            button.disabled = false;
            updateWalletPayButton();
        }
    }
}

// Bind functions to window for HTML onclick attributes
window.payWithExpressPay = payWithExpressPay;
window.updateWalletDisplay = updateWalletDisplay;
window.openLoadWalletModal = openLoadWalletModal;
window.closeLoadWalletModal = closeLoadWalletModal;
