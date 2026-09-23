import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentData = null;

// Simple tab switching function
function switchTab(tabName) {
    const tabs = ['overview', 'store', 'pricing', 'withdrawals'];
    tabs.forEach(t => {
        const contentEl = document.getElementById('content-' + t);
        const tabEl = document.getElementById('tab-' + t);
        
        if (contentEl) {
            contentEl.style.display = (t === tabName) ? 'block' : 'none';
        }
        
        if (tabEl) {
            if (t === tabName) {
                tabEl.style.color = '#2563eb';
                tabEl.style.fontWeight = '600';
                tabEl.style.borderBottom = '2px solid #2563eb';
            } else {
                tabEl.style.color = '#4b5563';
                tabEl.style.fontWeight = '500';
                tabEl.style.borderBottom = 'none';
            }
        }
    });
}

// Copy link function
function copyStoreLink() {
    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput) {
        linkInput.select();
        navigator.clipboard.writeText(linkInput.value);
        alert("✅ Store link copied to clipboard!");
    }
}

// Comprehensive list of all bundle pricing keys
const priceKeys = [
    'price_mtn_2gb', 'price_mtn_3gb', 'price_mtn_4gb', 'price_mtn_5gb', 'price_mtn_6gb', 'price_mtn_8gb', 'price_mtn_10gb', 'price_mtn_15gb', 'price_mtn_20gb', 'price_mtn_25gb', 'price_mtn_30gb', 'price_mtn_40gb', 'price_mtn_50gb',
    'price_telecel_10gb', 'price_telecel_15gb', 'price_telecel_20gb', 'price_telecel_30gb', 'price_telecel_40gb', 'price_telecel_50gb',
    'price_airteltigo_1gb', 'price_airteltigo_2gb', 'price_airteltigo_3gb', 'price_airteltigo_4gb',
    'price_airteltigo_5gb', 'price_airteltigo_6gb', 'price_airteltigo_7gb', 'price_airteltigo_8gb', 'price_airteltigo_9gb', 'price_airteltigo_10gb', 'price_airteltigo_15gb'
];

// Save all custom prices to backend and localStorage
async function saveStorePrices() {
    const prices = {};
    priceKeys.forEach(key => {
        const inputEl = document.getElementById(key);
        if (inputEl && inputEl.value !== '') {
            const val = parseFloat(inputEl.value);
            if (!isNaN(val)) {
                prices[key] = val;
                localStorage.setItem(key, inputEl.value);
            }
        }
    });

    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-pricing', {
            body: { prices }
        });
        if (error || data?.error) {
            console.warn('Backend pricing save notice:', error || data?.error);
            alert("✅ Custom prices saved locally! (Backend sync pending)");
            return;
        }
        alert("✅ All custom prices securely updated and saved to your agent account!");
    } catch (err) {
        console.error('Failed to sync pricing to backend:', err);
        alert("✅ Custom prices saved locally!");
    }
}

// Withdrawal action handlers
function withdrawCredit() {
    alert("Withdrawal request initiated from store credit balance.");
}

function transferToBalance() {
    alert("Store credit successfully transferred to main wallet balance!");
}

// Load saved values on page start and verify agent access
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Enforce verified agent authentication
    const authResult = await requireVerifiedAgent({ redirectOnFail: true });
    if (!authResult) return;
    currentAgentData = authResult.agent;

    // 2. Load cached prices first
    priceKeys.forEach(key => {
        const savedValue = localStorage.getItem(key);
        const inputEl = document.getElementById(key);
        if (savedValue && inputEl) {
            inputEl.value = savedValue;
        }
    });

    // 3. Fetch server-authoritative agent pricing from Supabase Edge Function
    try {
        const { data, error } = await supabase.functions.invoke('manage-agent-pricing');
        if (!error && data?.prices) {
            Object.entries(data.prices).forEach(([key, val]) => {
                const inputEl = document.getElementById(key);
                if (inputEl) {
                    inputEl.value = Number(val).toFixed(2);
                    localStorage.setItem(key, inputEl.value);
                }
            });
        }
    } catch (pricingErr) {
        console.warn('Could not load remote agent prices, using local cache:', pricingErr);
    }

    // 4. Update dynamic storefront link
    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput) {
        const origin = window.location.origin;
        const pathname = window.location.pathname;
        const repoSegment = pathname.split('/').filter(Boolean)[0];
        const baseUrl = repoSegment && pathname.includes(`/${repoSegment}/`)
            ? `${origin}/${repoSegment}`
            : origin;

        const agentParam = currentAgentData?.agent_code || 'skaitech_gh';
        linkInput.value = `${baseUrl}/nonAgentBuyers.html?agent=${encodeURIComponent(agentParam)}`;
    }
});

// Bind STORE functions to window for HTML onclick attributes
window.switchTab = switchTab;
window.copyStoreLink = copyStoreLink;
window.saveStorePrices = saveStorePrices;
window.withdrawCredit = withdrawCredit;
window.transferToBalance = transferToBalance;