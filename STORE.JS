import { supabase } from './supabaseClient.js';
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
    'price_mtn_1gb', 'price_mtn_2gb', 'price_mtn_3gb', 'price_mtn_4gb', 'price_mtn_5gb', 
    'price_mtn_6gb', 'price_mtn_8gb', 'price_mtn_10gb', 'price_mtn_15gb', 'price_mtn_22gb',
    'price_telecel_5gb', 'price_telecel_10gb', 'price_telecel_11gb', 'price_telecel_15gb', 
    'price_telecel_16gb', 'price_telecel_20gb', 'price_telecel_22gb',
    'price_airteltigo_1gb', 'price_airteltigo_2gb', 'price_airteltigo_3gb', 'price_airteltigo_4gb', 
    'price_airteltigo_5gb', 'price_airteltigo_6gb', 'price_airteltigo_8gb', 'price_airteltigo_10gb'
];

// Save all custom prices to localStorage
function saveStorePrices() {
    priceKeys.forEach(key => {
        const inputEl = document.getElementById(key);
        if (inputEl) {
            localStorage.setItem(key, inputEl.value);
        }
    });
    alert("✅ All custom prices updated and saved successfully!");
}

// Withdrawal action handlers
function withdrawCredit() {
    alert("Withdrawal request initiated from store credit balance.");
}

function transferToBalance() {
    alert("Store credit successfully transferred to main wallet balance!");
}

// Load saved values on page start
document.addEventListener('DOMContentLoaded', () => {
    priceKeys.forEach(key => {
        const savedValue = localStorage.getItem(key);
        const inputEl = document.getElementById(key);
        if (savedValue && inputEl) {
            inputEl.value = savedValue;
        }
    });

    const linkInput = document.getElementById('storeLinkInput');
    if (linkInput) {
        const origin = window.location.origin;
        const pathname = window.location.pathname;
        const repoSegment = pathname.split('/').filter(Boolean)[0];
        const baseUrl = repoSegment && pathname.includes(`/${repoSegment}/`)
            ? `${origin}/${repoSegment}`
            : origin;

        linkInput.value = `${baseUrl}/nonAgentBuyers.html?agent=skaitech_gh`;
    }
});
// Bind STORE functions to window for HTML onclick attributes
window.switchTab = switchTab;
window.copyStoreLink = copyStoreLink;
window.saveStorePrices = saveStorePrices;
window.withdrawCredit = withdrawCredit;
window.transferToBalance = transferToBalance;