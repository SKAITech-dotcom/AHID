/* ==========================================================================
   SKAITECH MASTER APPLICATION SCRIPT
   ========================================================================== */

// --- COOKIE FALLBACK HELPERS ---
function setCookie(name, value, days = 7) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/';
}

function getCookie(name) {
  return document.cookie.split('; ').reduce((r, v) => {
    const parts = v.split('=');
    return parts[0] === name ? decodeURIComponent(parts[1]) : r;
  }, '');
}

// --- AUTHENTICATION & REGISTRATION LOGIC ---
function handleRegistration(event) {
  event.preventDefault();

  const fullNameInput = document.getElementById('regName');
  const agentName = fullNameInput && fullNameInput.value.trim() !== '' 
    ? fullNameInput.value.trim() 
    : 'Agent';

  const generatedCode = 'AGT' + Math.floor(100 + Math.random() * 900);

  try {
    localStorage.setItem('currentAgentName', agentName);
    localStorage.setItem('currentAgentCode', generatedCode);
  } catch (e) {
    setCookie('currentAgentName', agentName);
    setCookie('currentAgentCode', generatedCode);
  }

  window.location.href = 'dashboard.html';
}

function switchTab(tab) {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const loginTab = document.getElementById('loginTab');
  const registerTab = document.getElementById('registerTab');

  if (!loginForm || !registerForm) return;

  if (tab === 'register') {
    loginForm.classList.add('hidden-form');
    registerForm.classList.remove('hidden-form');
    if (loginTab) loginTab.classList.remove('active');
    if (registerTab) registerTab.classList.add('active');
  } else {
    registerForm.classList.add('hidden-form');
    loginForm.classList.remove('hidden-form');
    if (registerTab) registerTab.classList.remove('active');
    if (loginTab) loginTab.classList.add('active');
  }
}

// --- DASHBOARD DISPLAY LOGIC ---
function loadDashboardAgentInfo() {
  const agentNameElement = document.getElementById('displayAgentName');
  const agentCodeElement = document.getElementById('displayAgentCode');
  const avatarElement = document.getElementById('userAvatarInitials');

  if (agentNameElement && agentCodeElement) {
    let storedName = '';
    let storedCode = '';

    try {
      storedName = localStorage.getItem('currentAgentName');
      storedCode = localStorage.getItem('currentAgentCode');
    } catch (e) {
      storedName = getCookie('currentAgentName');
      storedCode = getCookie('currentAgentCode');
    }

    if (!storedName) storedName = getCookie('currentAgentName') || 'Valued Agent';
    if (!storedCode) storedCode = getCookie('currentAgentCode') || ('AGT' + Math.floor(100 + Math.random() * 900));

    // Update greeting and agent code
    agentNameElement.textContent = storedName;
   agentCodeElement.textContent = `AGENT CODE: ${storedCode}`;

    // Extract first letter of first name and first letter of second name
    if (avatarElement && storedName) {
      const nameParts = storedName.trim().split(/\s+/);
      let initials = '';

      if (nameParts.length >= 2) {
        initials = nameParts[0].charAt(0) + nameParts[1].charAt(0);
      } else if (nameParts.length === 1 && nameParts[0].length > 0) {
        initials = nameParts[0].slice(0, 2);
      } else {
        initials = 'AG';
      }

      avatarElement.textContent = initials.toUpperCase();
    }
  }
}

    
// --- NAVIGATION & UI INTERACTION LOGIC ---
 function toggleDrawer() {
  const drawer = document.getElementById('sideDrawer');
  const overlay = document.getElementById('sidebarOverlay');

  if (drawer) {
    drawer.classList.toggle('active');
  }
  if (overlay) {
    overlay.classList.toggle('active');
  }
}



 // NETWORK BUNDLE PRICING DATA & LOGOS
const networkPackages = {
  'MTN': {
    label: 'MTN',
    themeClass: 'theme-mtn',
    logoUrl: 'img/mtn-logo.png',
    packages: [
      { size: '1 GB', price: 4.20 },
      { size: '2 GB', price: 8.20 },
      { size: '3 GB', price: 12.20 }
    ]
  },
  'Telecel': {
    label: 'TELECEL',
    themeClass: 'theme-telecel',
    logoUrl: 'img/telecel-logo.png',
    packages: [
      { size: '5 GB', price: 18.50 },
      { size: '10 GB', price: 35.00 },
      { size: '15 GB', price: 50.00 },
      { size: '20 GB', price: 65.00 }
    ]
  },
  'AirtelTigo': {
    label: 'AIRTELTIGO',
    themeClass: 'theme-airteltigo',
    logoUrl: 'img/airtel-logo.png',
    packages: [
      { size: '1 GB', price: 4.00 },
      { size: '2 GB', price: 8.00 },
      { size: '3 GB', price: 12.00 }
    ]
  }
};

/**
 * Dynamically builds package cards with network logos and theme styles
 */
function selectNetwork(netKey) {
  const container = document.getElementById('bundlesContainer');
  if (!container) return;

  const data = networkPackages[netKey] || networkPackages['MTN'];
  
  container.innerHTML = data.packages.map(pkg => `
    <div class="package-card ${data.themeClass || ''}">
      <div class="card-logo-wrapper">
        <img src="${data.logoUrl}" alt="${data.label}" class="card-network-logo" />
        <span class="status-dot"></span>
      </div>
      <span class="card-net-label">${data.label}</span>
      <div class="card-data-size">
        <i class="fa-solid fa-wifi text-sky-500 text-base"></i> ${pkg.size}
      </div>
      <div class="card-price-tag">GHS ${pkg.price.toFixed(2)}</div>
      <span class="card-pay-type">One-time payment</span>
      <button class="btn-add-cart" onclick="openBuyModal('${data.label}', '${pkg.size}', ${pkg.price})">
  <i class="fa-solid fa-bolt"></i> Buy Now
</button>
    </div>
  `).join('');
}  
   


let currentOrder = null;

function openBuyModal(network, size, price) {
    currentOrder = { network, size, price: parseFloat(price) };

    document.getElementById('modalTitle').innerText = `Buy ${network} Bundle`;
    document.getElementById('modalPackageDetails').innerText = `Package: ${size} - GHS ${parseFloat(price).toFixed(2)}`;
    document.getElementById('recipientPhone').value = '';
    document.getElementById('buyModal').style.display = 'flex';
}

function closeBuyModal() {
    currentOrder = null;
    document.getElementById('buyModal').style.display = 'none';
}

function processPurchase() {
    const phoneInput = document.getElementById('recipientPhone');
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!phone || phone.length < 10) {
        alert("Please enter a valid 10-digit phone number.");
        return;
    }

    if (!currentOrder || typeof currentOrder.price === 'undefined') {
        alert("No active order found!");
        return;
    }

    let currentBalance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    const bundlePrice = currentOrder.price;

    // 1. BLOCK PURCHASE IF BALANCE IS TOO LOW
    if (currentBalance < bundlePrice) {
        alert(`❌ Order Failed: Your wallet balance is GHS ${currentBalance.toFixed(2)}, but this bundle costs GHS ${bundlePrice.toFixed(2)}. Please fund your wallet!`);
        closeBuyModal();
        window.location.href = 'agentwallet.html';
        return;
    }

    // 2. DEDUCT BALANCE IF SUFFICIENT
    currentBalance -= bundlePrice;
    localStorage.setItem('agent_wallet_balance', currentBalance);

    // 3. CREATE ORDER & SAVE TO LOCALSTORAGE
    const newOrder = {
        id: 'SK' + Math.floor(1000 + Math.random() * 9000),
        network: currentOrder.network,
        phone: phone,
        package: currentOrder.size,
        price: currentOrder.price.toFixed(2),
        status: 'pending',
        date: new Date().toLocaleDateString()
    };

    const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    existingOrders.unshift(newOrder);
    localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

    alert(`Order Placed Successfully!\nNetwork: ${newOrder.network}\nSize: ${newOrder.package}\nPhone: ${phone}`);
    closeBuyModal();
}
// Run when page loads
document.addEventListener('DOMContentLoaded', () => {
  loadDashboardAgentInfo();
});
function toggleAccordion(headerElement) {
  const accordion = headerElement.parentElement;
  accordion.classList.toggle('active');
}
// REALTIME ORDER SEARCH FILTER

//  // REALTIME ORDER SEARCH FILTER
let currentFilter = 'all';

// SET ACTIVE FILTER PILL
function setFilter(status, element) {
    currentFilter = status;
    
    // Update pill active classes
    const buttons = document.querySelectorAll('.status-pills .pill-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    if (element) element.classList.add('active');

    filterOrders();
}

// FILTER ORDERS BY STATUS & PHONE SEARCH
function filterOrders() {
  const searchInput = document.getElementById('orderSearch');
  if (!searchInput) return;

  const searchText = searchInput.value.toLowerCase();
  const rows = document.querySelectorAll('#ordersTableBody tr');
  let visibleCount = 0;

  rows.forEach(row => {
    const statusMatch = (currentFilter === 'all') || (row.getAttribute('data-status') === currentFilter);
    const phoneMatch = row.innerText.toLowerCase().includes(searchText);

    if (statusMatch && phoneMatch) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });

  // Update total orders found counter text
  const countDisplay = document.getElementById('ordersCountText');
  if (countDisplay) {
    countDisplay.textContent = `${visibleCount} orders found`;
  }

  // Toggle between Empty State message and Data Table display
  const emptyState = document.getElementById('emptyState');
  const table = document.getElementById('ordersTable');

  if (visibleCount === 0) {
    if (emptyState) emptyState.style.display = 'block';
    if (table) table.style.display = 'none';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (table) table.style.display = 'table';
  }
}
// LOAD AND DISPLAY ORDERS WITH STATUS ACTIONS
// RENDER TABLE (AUTOMATIC DISPLAY - NO DROPDOWN)
function loadStoredOrders() {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    tableBody.innerHTML = '';

    // 1. Filter orders based on active tab
    const filteredOrders = savedOrders.filter(order => {
        if (currentFilter === 'all') return true;
        return order.status.toLowerCase() === currentFilter.toLowerCase();
    });

    // 2. Handle empty state display
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
        if (filteredOrders.length === 0) {
            emptyState.style.display = 'block';
        } else {
            emptyState.style.display = 'none';
        }
    }

    // 3. Calculate dynamic slice for pagination
    const startIndex = (currentPage - 1) * ordersPerPage;
    const endIndex = startIndex + Number(ordersPerPage);
    const paginatedOrders = filteredOrders.slice(startIndex, endIndex);

    // 4. Render rows
    paginatedOrders.forEach(order => {
        const row = document.createElement('tr');
        row.setAttribute('data-status', order.status.toLowerCase());
        row.innerHTML = `
            <td style="padding: 10px;"><strong>#${order.id}</strong></td>
            <td style="padding: 10px;">${order.network}</td>
            <td style="padding: 10px;">${order.phone}</td>
            <td style="padding: 10px;">${order.package}</td>
            <td style="padding: 10px;">
                <span class="status-badge badge-${order.status.toLowerCase()}">${order.status}</span>
            </td>
        `;
        tableBody.appendChild(row);
    });

    updatePaginationUI(filteredOrders.length);
}

// SIMULATED AUTOMATIC STATUS PROGRESSION
function triggerAutoApiFlow(orderId) {
  // Move to Processing after 4 seconds
  setTimeout(() => {
    updateOrderStatusInMemory(orderId, 'processing');
  }, 4000);

  // Move to Completed after 10 seconds
  setTimeout(() => {
    updateOrderStatusInMemory(orderId, 'completed');
  }, 10000);
}

function updateOrderStatusInMemory(orderId, newStatus) {
  const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
  const order = savedOrders.find(item => item.id === orderId);
  if (order) {
    order.status = newStatus;
    localStorage.setItem('skaitechOrders', JSON.stringify(savedOrders));
    
    // Auto-refresh table view if on orders.html
    if (document.getElementById('ordersTableBody')) {
      loadStoredOrders();
    }
  }
}

// RUN ON PAGE LOAD
document.addEventListener('DOMContentLoaded', () => {
  loadStoredOrders();
});

 let currentPage = 1;
let ordersPerPage = 10;
 currentFilter = 'all';

// function setFilter(filterType) {
//     currentFilter = filterType;
//     currentPage = 1;
//     loadStoredOrders();
// }

function loadStoredOrders() {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    tableBody.innerHTML = '';

    // 1. Filter orders based on active tab
    const filteredOrders = savedOrders.filter(order => {
        if (currentFilter === 'all') return true;
        return order.status.toLowerCase() === currentFilter.toLowerCase();
    });

    // 2. Handle empty state display
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
        if (filteredOrders.length === 0) {
            emptyState.style.display = 'block';
        } else {
            emptyState.style.display = 'none';
        }
    }

    // 3. Calculate dynamic slice for pagination
    const startIndex = (currentPage - 1) * ordersPerPage;
    const endIndex = startIndex + Number(ordersPerPage);
    const paginatedOrders = filteredOrders.slice(startIndex, endIndex);

    // 4. Render rows
    paginatedOrders.forEach(order => {
        const row = document.createElement('tr');
        row.setAttribute('data-status', order.status.toLowerCase());
        row.innerHTML = `
            <td style="padding: 10px;"><strong>#${order.id}</strong></td>
            <td style="padding: 10px;">${order.network}</td>
            <td style="padding: 10px;">${order.phone}</td>
            <td style="padding: 10px;">${order.package}</td>
            <td style="padding: 10px;">
                <span class="status-badge badge-${order.status.toLowerCase()}">${order.status}</span>
            </td>
        `;
        tableBody.appendChild(row);
    });

    updatePaginationUI(filteredOrders.length);
}
  

function updatePaginationUI(totalOrders) {
  const totalPages = Math.ceil(totalOrders / ordersPerPage) || 1;
  const pageIndicator = document.getElementById('pageIndicator');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');

  if (pageIndicator) pageIndicator.innerText = `Page ${currentPage} of ${totalPages}`;
  if (prevBtn) prevBtn.disabled = currentPage === 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function changePage(direction) {
  currentPage += direction;
  loadStoredOrders();
}

function changePageSize(newSize) {
  ordersPerPage = Number(newSize);
  currentPage = 1;
  loadStoredOrders();
}

// SIMULATED AUTOMATIC STATUS PROGRESSION
function triggerAutoApiFlow(orderId) {
  setTimeout(() => {
    updateOrderStatusInMemory(orderId, 'processing');
  }, 4000);

  setTimeout(() => {
    updateOrderStatusInMemory(orderId, 'completed');
  }, 10000);
}

function updateOrderStatusInMemory(orderId, newStatus) {
  const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
  const order = savedOrders.find(item => item.id === orderId);
  if (order) {
    order.status = newStatus;
    localStorage.setItem('skaitechOrders', JSON.stringify(savedOrders));
    
    if (document.getElementById('ordersTableBody')) {
      loadStoredOrders();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadStoredOrders();
});

function handleReportMessage(event) {
    event.preventDefault();
    const name = document.getElementById('msgName').value;
    const email = document.getElementById('msgEmail').value;
    const message = document.getElementById('msgContent').value;

    // You can hook this up to your backend, Supabase, or trigger an alert confirmation
    alert(`Thank you, ${name}! Your message has been sent successfully. We will get back to you via ${email}.`);
    
    // Clear the form fields
    document.getElementById('reportMessageForm').reset();
}
function toggleFaq(button) {
    const item = button.parentElement;
    const isActive = item.classList.contains('active');

    // Close all FAQ items first
    document.querySelectorAll('.faq-item').forEach(el => {
        el.classList.remove('active');
    });

    // If it wasn't active before, open it now
    if (!isActive) {
        item.classList.add('active');
    }
}

const menuToggleBtn = document.getElementById('menuToggleBtn');
const dropdownMenu = document.getElementById('dropdownMenu');

if (menuToggleBtn && dropdownMenu) {
    menuToggleBtn.addEventListener('click', () => {
        if (dropdownMenu.style.display === 'none' || dropdownMenu.style.display === '') {
            dropdownMenu.style.display = 'block';
        } else {
            dropdownMenu.style.display = 'none';
        }
    });
}

function toggleMenu() {
    const dropdown = document.getElementById('dropdownMenu');
    const symbol = document.getElementById('menuIconSymbol');
    
    // Toggles your dropdown menu visibility
    dropdown.classList.toggle('show'); 
    
    // Switches between the 3 lines and the 'X' close icon
    if (symbol.innerText === '≡') {
        symbol.innerText = '✕';
    } else {
        symbol.innerText = '≡';
    }
}
function toggleMenu() {
    const dropdown = document.getElementById('dropdownMenu');
    const symbol = document.getElementById('menuIconSymbol');
    
    // Toggles your dropdown menu visibility
    dropdown.classList.toggle('show'); 
    
    // Switches between the 3 lines and the 'X' close icon
    if (symbol.innerText === '≡') {
        symbol.innerText = '✕';
    } else {
        symbol.innerText = '≡';
    }
}
function openForgotModal(event) {
    event.preventDefault();
    document.getElementById('forgotPasswordModal').style.display = 'flex';
}

function closeForgotModal() {
    document.getElementById('forgotPasswordModal').style.display = 'none';
}

function submitPasswordReset() {
    const inputVal = document.getElementById('resetEmailOrPhone').value.trim();
    
    if (!inputVal) {
        alert('Please enter your email or phone number.');
        return;
    }
    
    // Simulate sending recovery info
    alert(`Password reset instructions have been sent to: ${inputVal}`);
    document.getElementById('resetEmailOrPhone').value = '';
    closeForgotModal();
}

function togglePasswordVisibility() {
    const passwordInput = document.getElementById('passwordInput');
    const eyeIcon = document.getElementById('eyeIcon');
    
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash'); // Changes to a slashed eye when visible
    } else {
        passwordInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
    }
}

// Low balance check guard function for orders placed from dashboard
function checkOrderBalanceBeforeAction(orderPrice) {
    let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    if (balance < orderPrice) {
        alert(`⚠️ Warning: Your account balance (GHS ${balance.toFixed(2)}) is too low for this transaction! Please fund your wallet.`);
        window.location.href = 'agentwallet.html';
        return false;
    }
    return true;
}

// Populate popup balance on load
document.addEventListener('DOMContentLoaded', () => {
    const popupBal = document.getElementById('popupBalanceVal');
    if (popupBal) {
        const bal = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
        popupBal.innerText = `GHS ${bal.toFixed(2)}`;
    }
});
