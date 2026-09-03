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
        { size: '1GB', price: 'GHS 15.00', validity: 'One-time payment' },
        { size: '2GB', price: 'GHS 28.00', validity: 'One-time payment' },
        { size: '5GB', price: 'GHS 65.00', validity: 'One-time payment' }
    ],
    telecel: [
        { size: '1GB', price: 'GHS 13.00', validity: 'One-time payment' },
        { size: '3GB', price: 'GHS 35.00', validity: 'One-time payment' },
        { size: '5GB', price: 'GHS 55.00', validity: 'One-time payment' }
    ],
    airteltigo: [
        { size: '2GB', price: 'GHS 20.00', validity: 'One-time payment' },
        { size: '5GB', price: 'GHS 45.00', validity: 'One-time payment' },
        { size: '10GB', price: 'GHS 85.00', validity: 'One-time payment' }
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

// Order Submission
function submitOrder(size, price, index) {
    const nameInput = document.getElementById(`name_${index}`);
    const phoneInput = document.getElementById(`phone_${index}`);
    
    const name = nameInput ? nameInput.value.trim() : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!name || !phone) {
        alert('Please fill in both your name and phone number.');
        return;
    }

    // Generate a unique tracking ID
    const trackingId = 'SKAI-' + Math.floor(100000 + Math.random() * 900000);
    
    // Create order object
    const orderDetails = {
        trackingId: trackingId,
        network: network.toUpperCase(),
        size: size,
        price: price,
        name: name,
        phone: phone,
        status: 'Processing',
        date: new Date().toLocaleString()
    };

    // Save order to browser storage
    let existingOrders = JSON.parse(localStorage.getItem('skaitech_orders')) || [];
    existingOrders.unshift(orderDetails);
    localStorage.setItem('skaitech_orders', JSON.stringify(existingOrders));

    // Show success popup with Tracking ID
    alert(`Order Placed Successfully!\n\nYour Tracking ID is: ${trackingId}\nPlease save this ID to track your order.`);
    
    toggleOrderForm(index);
}