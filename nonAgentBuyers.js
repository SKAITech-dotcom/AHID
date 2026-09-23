import { supabase } from './supabaseClient.js';

const paymentReference = new URLSearchParams(window.location.search).get('reference');
// Read the network from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const network = urlParams.get('network') || 'mtn';

const bannerElem = document.getElementById('networkBanner');
const listElem = document.getElementById('packageList');

// Brand Theme configurations matching the reference images
const themes = {
    mtn: { 
        name: 'MTN Data Bundle', 
        primary: '#f59e0b', // Amber/Yellow
        gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        badgeBg: '#fef3c7', 
        badgeText: '#b45309' 
    },
    telecel: { 
        name: 'Telecel Data Bundle', 
        primary: '#dc2626', // Red
        gradient: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
        badgeBg: '#fee2e2', 
        badgeText: '#991b1b' 
    },
    airteltigo: { 
        name: 'AirtelTigo', 
        primary: '#2563eb', // Blue
        gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
        badgeBg: '#eff6ff', 
        badgeText: '#1e40af' 
    }
};

const currentTheme = themes[network] || themes['mtn'];

// Package Data sets
const packagesData = {
    mtn: [
        { size: '2GB', price: 'GHS 8.80', validity: 'One-time payment' },
        { size: '3GB', price: 'GHS 13.20', validity: 'One-time payment' },
        { size: '4GB', price: 'GHS 17.60', validity: 'One-time payment' },
        { size: '5GB', price: 'GHS 22.00', validity: 'One-time payment' },
        { size: '6GB', price: 'GHS 26.10', validity: 'One-time payment' },
        { size: '8GB', price: 'GHS 34.80', validity: 'One-time payment' },
        { size: '10GB', price: 'GHS 42.00', validity: 'One-time payment' },
        { size: '15GB', price: 'GHS 63.00', validity: 'One-time payment' },
        { size: '20GB', price: 'GHS 84.00', validity: 'One-time payment' },
        { size: '25GB', price: 'GHS 103.75', validity: 'One-time payment' },
        { size: '30GB', price: 'GHS 121.50', validity: 'One-time payment' },
        { size: '40GB', price: 'GHS 160.00', validity: 'One-time payment' },
        { size: '50GB', price: 'GHS 200.00', validity: 'One-time payment' }
    ],
    telecel: [
        { size: '10GB', price: 'GHS 40.00', validity: 'One-time payment' },
        { size: '15GB', price: 'GHS 60.00', validity: 'One-time payment' },
        { size: '20GB', price: 'GHS 78.00', validity: 'One-time payment' },
        { size: '30GB', price: 'GHS 114.00', validity: 'One-time payment' },
        { size: '40GB', price: 'GHS 151.00', validity: 'One-time payment' },
        { size: '50GB', price: 'GHS 185.00', validity: 'One-time payment' }
    ],
    airteltigo: [
        { size: '1GB', price: 'GHS 4.20', validity: 'One-time payment' },
        { size: '2GB', price: 'GHS 8.39', validity: 'One-time payment' },
        { size: '3GB', price: 'GHS 12.58', validity: 'One-time payment' },
        { size: '4GB', price: 'GHS 16.78', validity: 'One-time payment' },
        { size: '5GB', price: 'GHS 20.97', validity: 'One-time payment' },
        { size: '6GB', price: 'GHS 25.17', validity: 'One-time payment' },
        { size: '7GB', price: 'GHS 29.36', validity: 'One-time payment' },
        { size: '8GB', price: 'GHS 33.56', validity: 'One-time payment' },
        { size: '9GB', price: 'GHS 37.53', validity: 'One-time payment' },
        { size: '10GB', price: 'GHS 40.84', validity: 'One-time payment' },
        { size: '15GB BigTime', price: 'GHS 60.71', validity: 'One-time payment' }
    ]
};

const currentPackages = packagesData[network] || packagesData['mtn'];

// Set Top Banner
if (bannerElem) {
    bannerElem.innerText = currentTheme.name;
    bannerElem.style.background = currentTheme.gradient;
}

// Generate Product Cards HTML
if (listElem) {
    let htmlContent = '';
    
    currentPackages.forEach((pkg, index) => {
        htmlContent += `
            <div class="product-card">
                <div class="card-badge">
                    <i class="fa-solid fa-circle" style="font-size: 6px; color: #10b981;"></i> ${network.toUpperCase()}
                </div>
                <div class="data-size">
                    <i class="fa-solid fa-wifi" style="font-size: 1rem; color: ${currentTheme.primary};"></i> ${pkg.size}
                </div>
                <div class="data-price" style="color: ${currentTheme.primary};">${pkg.price}</div>
                <div class="payment-type">${pkg.validity}</div>
                
                <button onclick="toggleOrderForm(${index})" class="action-btn" style="background: ${currentTheme.gradient};">
                    <i class="fa-solid fa-bag-shopping"></i> Buy Now
                </button>
                
                <!-- Hidden Checkout Input Form with Cancel Button -->
                <div id="orderForm_${index}" style="display: none;" class="form-container">
                    <label style="font-size: 0.8rem; font-weight: 700; color: #374151;">Your Name:</label>
                    <input type="text" id="name_${index}" placeholder="Full Name" class="form-input">

                    <label style="font-size: 0.8rem; font-weight: 700; color: #374151;">Your Email:</label>
                    <input type="email" id="email_${index}" placeholder="you@example.com" class="form-input">
                    
                    <label style="font-size: 0.8rem; font-weight: 700; color: #374151;">Recipient Phone (${network.toUpperCase()}):</label>
                    <input type="tel" id="phone_${index}" placeholder="024XXXXXXX" class="form-input">
                    
                    <div style="display: flex; gap: 8px; margin-top: 4px;">
                        <button onclick="submitOrder('${pkg.size}', '${pkg.price}', ${index})" class="action-btn" style="background: ${currentTheme.gradient}; flex: 2; margin-top: 0;">
                            Confirm Order
                        </button>
                        <button onclick="toggleOrderForm(${index})" style="background: #e5e7eb; color: #374151; border: none; padding: 12px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; cursor: pointer; flex: 1;">
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        `;
    });

    listElem.innerHTML = htmlContent;
}

// Toggle Form Visibility
function toggleOrderForm(index) {
    const form = document.getElementById(`orderForm_${index}`);
    if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }
}

async function showPaymentResult() {
    if (!paymentReference) return;
    const saved = JSON.parse(sessionStorage.getItem('skaitech_public_payment') || '{}');
    if (saved.reference !== paymentReference || !saved.email) return;

    const { data, error } = await supabase.functions.invoke('get-public-data-order', {
        body: { reference: paymentReference, email: saved.email }
    });
    if (error || data?.error) {
        alert(data?.error || 'Unable to retrieve your order status.');
        return;
    }
    const order = data.order;
    if (order.status === 'successful') {
        const orders = JSON.parse(localStorage.getItem('skaitech_orders') || '[]');
        orders.unshift({ trackingId: paymentReference, network: order.network_type.toUpperCase(), size: `${order.volume_mb / 1024}GB`, price: `GHS ${Number(order.sale_amount).toFixed(2)}`, name: saved.name, phone: saved.phone, status: 'Successful', date: new Date(order.created_at).toLocaleString() });
        localStorage.setItem('skaitech_orders', JSON.stringify(orders));
        alert(`Payment confirmed and bundle delivered.\nTracking ID: ${paymentReference}`);
    } else if (order.status === 'failed') {
        alert('Payment was received, but the bundle could not be delivered. Please contact support for a refund.');
    } else {
        alert('Payment received. Your bundle is still being processed. Please check again shortly.');
    }
}

// Order Submission
async function submitOrder(size, price, index) {
    const nameInput = document.getElementById(`name_${index}`);
    const emailInput = document.getElementById(`email_${index}`);
    const phoneInput = document.getElementById(`phone_${index}`);
    
    const name = nameInput ? nameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!name || !email || !phone) {
        alert('Please fill in your name, email, and phone number.');
        return;
    }
    const button = document.querySelector(`#orderForm_${index} .action-btn`);
    if (button) { button.disabled = true; button.textContent = 'Opening secure checkout...'; }
    try {
        const { data, error } = await supabase.functions.invoke('create-public-data-payment', {
            body: { name, email, phone, networkType: network, volumeInMB: Number.parseFloat(size) * 1024 }
        });
        if (error) throw error;
        if (!data?.authorizationUrl) throw new Error(data?.error || 'Unable to start payment.');
        sessionStorage.setItem('skaitech_public_payment', JSON.stringify({ reference: data.reference, email, name, phone }));
        window.location.href = data.authorizationUrl;
    } catch (error) {
        alert(error.message || 'Unable to start secure payment.');
        if (button) { button.disabled = false; button.textContent = 'Confirm Order'; }
    }
}

// Bind nonAgentBuyers functions to window for HTML onclick attributes
window.toggleOrderForm = toggleOrderForm;
window.submitOrder = submitOrder;

showPaymentResult();
