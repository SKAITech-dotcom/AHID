import { supabase } from './supabaseClient.js';
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

function generateAgentCode() {
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  return `SKAI-${token}`;
}

async function ensureAgentProfile(userId, agentName, agentCode, phone = '') {
  const profileData = { id: userId, full_name: agentName, agent_code: agentCode, phone };
  const profileResult = await supabase.from('profiles').upsert(profileData, { onConflict: 'id' });
  const agentResult = await supabase.from('agents').upsert({
    id: userId,
    full_name: agentName,
    agent_code: agentCode,
    phone,
    role: 'agent'
  }, { onConflict: 'id' });
  const walletResult = await supabase.from('wallets').upsert({
    id: userId,
    balance: 0.00
  }, { onConflict: 'id' });

  return {
    profileError: profileResult.error,
    agentError: agentResult.error,
    walletError: walletResult.error
  };
}

function ensureLocalWebServer() {
  if (window.location.protocol === 'file:') {
    throw new Error('Please open this app through a local web server URL such as http://localhost:8000 before ordering data.');
  }
}

async function getValidAgentSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return session;
}

// --- AUTHENTICATION & REGISTRATION LOGIC ---
async function handleLogin(event) {
  if (event) event.preventDefault();
  const identifierInput = document.getElementById('loginEmail') || document.getElementById('regName');
  const passwordInput = document.getElementById('passwordInput') || document.getElementById('loginPassword');

  const identifier = identifierInput ? identifierInput.value.trim().toLowerCase() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!identifier || !password) {
    alert('Please enter your email/phone and password.');
    return;
  }

  if (!identifier.includes('@')) {
    alert('Please sign in with the email address on your account.');
    return;
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: identifier,
      password: password
    });

    if (error || !data?.user) {
      const authMessage = error?.message?.toLowerCase() || '';
      if (error?.code === 'email_not_confirmed' || authMessage.includes('email not confirmed')) {
        alert('Your email is not confirmed. Check your inbox or spam folder for the confirmation link. Please do not repeatedly request new links because Supabase limits email delivery.');
        return;
      }
      if (authMessage.includes('rate limit') || authMessage.includes('email rate')) {
        alert('Email delivery is temporarily rate-limited. Wait a few minutes before trying again, or disable email confirmation in Supabase while testing.');
        return;
      }
      alert(error?.message || 'Unable to sign in. Please check your details.');
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, agent_code')
      .eq('id', data.user.id)
      .single();

    const agentName = profile?.full_name || data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || 'Agent';
    const agentCode = profile?.agent_code || data.user.user_metadata?.agent_code || '';

    const effectiveAgentCode = agentCode || generateAgentCode();

    if (!profile) {
      const setupErrors = await ensureAgentProfile(data.user.id, agentName, effectiveAgentCode, '');
      if (setupErrors.profileError || setupErrors.agentError || setupErrors.walletError) {
        console.error('Account setup failed after sign-in:', setupErrors);
      }
    }

    localStorage.setItem('currentAgentName', agentName);
    localStorage.setItem('agent_name', agentName);
    localStorage.setItem('currentAgentCode', effectiveAgentCode);
    window.location.href = 'dashboard.html';
  } catch (err) {
    console.error('Supabase sign-in failed:', err);
    if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
      alert('Connection failed. Open this site through the local server URL, not by double-clicking the HTML file, then try again.');
      return;
    }
    alert('Unable to sign in right now. Please try again.');
  }
}

async function handleRegistration(event) {
  if (event) event.preventDefault();

  const fullNameInput = document.getElementById('regName');
  const phoneInput = document.getElementById('regPhone');
  const emailInput = document.getElementById('regEmail');
  const passwordInput = document.getElementById('regPassword');

  const agentName = fullNameInput && fullNameInput.value.trim() !== '' 
    ? fullNameInput.value.trim() 
    : 'Agent';
  const phone = phoneInput ? phoneInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address.');
    return;
  }
  if (password.length < 6) {
    alert('Password must be at least 6 characters.');
    return;
  }

  const generatedCode = generateAgentCode();

  try {
      const { data, error } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
          data: {
            full_name: agentName,
            phone: phone,
            agent_code: generatedCode
          }
        }
      });

      if (error || !data?.user) {
        const authMessage = error?.message?.toLowerCase() || '';
        if (authMessage.includes('signups not allowed') || authMessage.includes('signup is disabled')) {
          alert('New accounts are disabled in Supabase. In Supabase Dashboard, open Authentication > Settings and enable Allow new users to sign up, then try again.');
          return;
        }
        if (authMessage.includes('rate limit') || authMessage.includes('email rate')) {
          alert('Email delivery is temporarily rate-limited. Wait a few minutes before creating another account, or disable email confirmation in Supabase while testing.');
          return;
        }
        alert(error?.message || 'Unable to create your account.');
        return;
      }

      if (!data.session) {
        alert('Account created. Check your email to confirm your account, then sign in.');
        window.location.href = 'login.html';
        return;
      }

      const setupErrors = await ensureAgentProfile(data.user.id, agentName, generatedCode, phone);
      if (setupErrors.profileError || setupErrors.agentError || setupErrors.walletError) {
        console.warn('Profile/wallet setup was blocked; continuing with the authenticated session:', setupErrors);
      }
  } catch (err) {
    console.error('Supabase sign-up failed:', err);
    alert('Unable to create your account right now. Please try again.');
    return;
  }

  try {
    localStorage.setItem('currentAgentName', agentName);
    localStorage.setItem('agent_name', agentName);
    localStorage.setItem('currentAgentCode', generatedCode);
    if (!localStorage.getItem('agent_wallet_balance')) {
      localStorage.setItem('agent_wallet_balance', '0');
    }
  } catch (e) {
    setCookie('currentAgentName', agentName);
    setCookie('currentAgentCode', generatedCode);
  }

  window.location.href = 'dashboard.html';
}

 window.switchTab = function(tab) {
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
      storedName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name');
      storedCode = localStorage.getItem('currentAgentCode');
    } catch (e) {
      storedName = getCookie('currentAgentName');
      storedCode = getCookie('currentAgentCode');
    }

    if (!storedName) storedName = getCookie('currentAgentName') || 'Valued Agent';
    if (!storedCode) {
      storedCode = getCookie('currentAgentCode') || generateAgentCode();
      try { localStorage.setItem('currentAgentCode', storedCode); } catch (e) { setCookie('currentAgentCode', storedCode); }
    }

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
      { size: '2 GB', price: 8.30 },
      { size: '3 GB', price: 12.20 },
      { size: '4 GB', price: 16.20 },
      { size: '5 GB', price: 20.50 },
      { size: '6 GB', price: 24.80 },
      { size: '8 GB', price: 34.00 },
      { size: '10 GB', price: 40.00 },
      { size: '15 GB', price: 58.60 },
      { size: '20 GB', price: 78.00 },
      { size: '25 GB', price: 98.00 },
      { size: '30 GB', price: 118.00 },
      { size: '40 GB', price: 156.00 },
      { size: '50 GB', price: 195.00 },
      { size: '100 GB', price: 375.00 }
    ]
  },
  'Telecel': {
    label: 'TELECEL',
    themeClass: 'theme-telecel',
    logoUrl: 'img/telecel-logo.png',
    packages: [
      { size: '5 GB', price: 18.50 },
      { size: '10 GB', price: 35.00 },
      { size: '11 GB', price: 39.00 },
      { size: '15 GB', price: 52.00 },
      { size: '16 GB', price: 58.00 },
      { size: '20 GB', price: 69.00 },
      { size: '22 GB', price: 79.00 },
      { size: '25 GB', price: 86.00 },
      { size: '27 GB', price: 98.00 },
      { size: '30 GB', price: 103.00 },
      { size: '33 GB', price: 114.00 },
      { size: '40 GB', price: 137.00 },
      { size: '44 GB', price: 150.00 },
      { size: '50 GB', price: 171.00 },
      { size: '100 GB', price: 357.00 },
      { size: '110 GB', price: 370.00 }
    ]
  },
  'AirtelTigo': {
    label: 'AIRTELTIGO',
    themeClass: 'theme-airteltigo',
    logoUrl: 'img/airtel-logo.png',
    packages: [
      { size: '1 GB', price: 4.00 },
      { size: '2 GB', price: 8.00 },
      { size: '3 GB', price: 12.00 },
      { size: '4 GB', price: 16.00 },
      { size: '5 GB', price: 20.00 },
      { size: '6 GB', price: 24.00 },
      { size: '7 GB', price: 28.00 },
      { size: '8 GB', price: 32.00 },
      { size: '9 GB', price: 36.00 },
      { size: '30 GB', price: 65.00 },
      { size: '40 GB', price: 75.00 },
      { size: '50 GB', price: 90.00 },
      { size: '60 GB', price: 110.00 },
      { size: '70 GB', price: 125.00 },
      { size: '80 GB', price: 150.00 },
      { size: '100 GB', price: 175.00 },
      { size: '150 GB', price: 220.00 },
      { size: '200 GB', price: 330.00 }
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

async function processPurchase() {
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

    try {
      ensureLocalWebServer();
    } catch (serverError) {
      alert(serverError.message);
      return;
    }

    const networkMap = { MTN: 'mtn', TELECEL: 'telecel', AIRTELTIGO: 'airteltigo' };
    const networkType = networkMap[currentOrder.network.toUpperCase()];
    const volumeInMB = Number.parseFloat(currentOrder.size) * 1024;
    const button = document.querySelector('#buyModal .btn-confirm');

    if (!networkType || !Number.isFinite(volumeInMB)) {
      alert('This bundle is not configured correctly.');
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Processing secure order...';
    }

    try {
      const session = await getValidAgentSession();
      const { data, error } = await supabase.functions.invoke('purchase-agent-data', {
        body: { phone, networkType, volumeInMB, amount: currentOrder.price },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (error) {
        // Supabase wraps every non-2xx function response in a generic
        // FunctionsHttpError. Its response body contains the safe message the
        // function returned (for example, a provider price or order failure).
        let responseMessage = data?.error;
        const response = error?.context;
        if (!responseMessage && response instanceof Response) {
          const errorBody = await response.clone().json().catch(() => null);
          if (errorBody && typeof errorBody.error === 'string') responseMessage = errorBody.error;
        }

        const message = responseMessage
          || (typeof error?.message === 'string' ? error.message : '')
          || 'Unable to complete the data order.';
        if (/failed to fetch|unexpected.*fetch/i.test(message)) {
          throw new Error('The ordering service is unavailable. Check your internet connection and try again.');
        }
        throw new Error(message);
      }
      if (!data?.success) throw new Error(data?.error || 'The data order was not completed.');

      const newOrder = {
        id: data.orderReference,
        network: currentOrder.network,
        phone,
        package: currentOrder.size,
        price: Number(data.amount ?? currentOrder.price).toFixed(2),
        status: 'successful',
        date: new Date().toLocaleDateString()
      };
      const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
      existingOrders.unshift(newOrder);
      localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

      alert(`Order completed successfully!\nNetwork: ${newOrder.network}\nSize: ${newOrder.package}\nPhone: ${phone}`);
      closeBuyModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to complete the data order. Your wallet was not charged if the provider failed.';
      alert(message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Confirm & Buy';
      }
    }
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

// function loadStoredOrders() {
//     const tableBody = document.getElementById('ordersTableBody');
//     if (!tableBody) return;

//     const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
//     tableBody.innerHTML = '';

//     // 1. Filter orders based on active tab
//     const filteredOrders = savedOrders.filter(order => {
//         if (currentFilter === 'all') return true;
//         return order.status.toLowerCase() === currentFilter.toLowerCase();
//     });

//     // 2. Handle empty state display
//     const emptyState = document.getElementById('emptyState');
//     if (emptyState) {
//         if (filteredOrders.length === 0) {
//             emptyState.style.display = 'block';
//         } else {
//             emptyState.style.display = 'none';
//         }
//     }

//     // 3. Calculate dynamic slice for pagination
//     const startIndex = (currentPage - 1) * ordersPerPage;
//     const endIndex = startIndex + Number(ordersPerPage);
//     const paginatedOrders = filteredOrders.slice(startIndex, endIndex);

//     // 4. Render rows
//     paginatedOrders.forEach(order => {
//         const row = document.createElement('tr');
//         row.setAttribute('data-status', order.status.toLowerCase());
//         row.innerHTML = `
//             <td style="padding: 10px;"><strong>#${order.id}</strong></td>
//             <td style="padding: 10px;">${order.network}</td>
//             <td style="padding: 10px;">${order.phone}</td>
//             <td style="padding: 10px;">${order.package}</td>
//             <td style="padding: 10px;">
//                 <span class="status-badge badge-${order.status.toLowerCase()}">${order.status}</span>
//             </td>
//         `;
//         tableBody.appendChild(row);
//     });

//     updatePaginationUI(filteredOrders.length);
// }


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

// // SIMULATED AUTOMATIC STATUS PROGRESSION
// function triggerAutoApiFlow(orderId) {
//   setTimeout(() => {
//     updateOrderStatusInMemory(orderId, 'processing');
//   }, 4000);

//   setTimeout(() => {
//     updateOrderStatusInMemory(orderId, 'completed');
//   }, 10000);
// }

// function updateOrderStatusInMemory(orderId, newStatus) {
//   const savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
//   const order = savedOrders.find(item => item.id === orderId);
//   if (order) {
//     order.status = newStatus;
//     localStorage.setItem('skaitechOrders', JSON.stringify(savedOrders));

//     if (document.getElementById('ordersTableBody')) {
//       loadStoredOrders();
//     }
//   }
// }

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

// function toggleMenu() {
//     const dropdown = document.getElementById('dropdownMenu');
//     const symbol = document.getElementById('menuIconSymbol');

//     // Toggles your dropdown menu visibility
//     dropdown.classList.toggle('show');

//     // Switches between the 3 lines and the 'X' close icon
//     if (symbol.innerText === 'Ã¢â€°Â¡') {
//         symbol.innerText = 'Ã¢Å“â€¢';
//     } else {
//         symbol.innerText = 'Ã¢â€°Â¡';
//     }
// }
// function toggleMenu() {
//     const dropdown = document.getElementById('dropdownMenu');
//     const symbol = document.getElementById('menuIconSymbol');

//     // Toggles your dropdown menu visibility
//     dropdown.classList.toggle('show');

//     // Switches between the 3 lines and the 'X' close icon
//     if (symbol.innerText === 'Ã¢â€°Â¡') {
//         symbol.innerText = 'Ã¢Å“â€¢';
//     } else {
//         symbol.innerText = 'Ã¢â€°Â¡';
//     }
// }

function toggleMenu() {
    const dropdown = document.getElementById('dropdownMenu');
    const symbol = document.getElementById('menuIconSymbol');

    dropdown.classList.toggle('show');

    if (symbol.innerText === 'Ã¢â€°Â¡') {
        symbol.innerText = 'Ã¢Å“â€¢';
    } else {
        symbol.innerText = 'Ã¢â€°Â¡';
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
        alert(`Ã¢Å¡Â Ã¯Â¸Â Warning: Your account balance (GHS ${balance.toFixed(2)}) is too low for this transaction! Please fund your wallet.`);
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
// Global Window Bindings for HTML Inline Event Handlers
window.toggleDrawer = toggleDrawer;
window.toggleAccordion = toggleAccordion;
window.selectNetwork = selectNetwork;
window.openBuyModal = openBuyModal;
window.closeBuyModal = closeBuyModal;
window.processPurchase = processPurchase;
window.setFilter = setFilter;
window.filterOrders = filterOrders;
window.changePage = changePage;
window.changePageSize = changePageSize;
window.openForgotModal = openForgotModal;
window.closeForgotModal = closeForgotModal;
window.submitPasswordReset = submitPasswordReset;
window.togglePasswordVisibility = togglePasswordVisibility;
window.handleRegistration = handleRegistration;
window.handleLogin = handleLogin;
window.switchTab = switchTab;
window.toggleFaq = toggleFaq;
window.toggleMenu = toggleMenu;
window.handleReportMessage = handleReportMessage;
window.loadStoredOrders = loadStoredOrders;
window.loadDashboardAgentInfo = loadDashboardAgentInfo;
window.loadUserData = loadUserData;

async function loadUserData() {
  const currentPath = window.location.pathname.toLowerCase();

  if (currentPath.endsWith('afa.html') || currentPath.endsWith('agentafa.html')) {
    window.location.href = 'index.html';
    return;
  }

  const isLoginPage = currentPath.endsWith('login.html');
  const isPublicPage = isLoginPage ||
    currentPath.endsWith('index.html') ||
    currentPath.endsWith('ourhelpdesk.html') ||
    currentPath.endsWith('nonagentbuyers.html') ||
    currentPath.endsWith('nonagenttrachorder.html') ||
    currentPath.endsWith('resultschecker.html') ||
    currentPath.endsWith('nonagentdashboard.html') ||
    currentPath === '/' ||
    currentPath.endsWith('/');

  const isProtectedAgentPage = currentPath.endsWith('dashboard.html') ||
    currentPath.endsWith('orders.html') ||
    currentPath.endsWith('agentwallet.html') ||
    currentPath.endsWith('deposit.html') ||
    currentPath.endsWith('store.html');

  // Never redirect on login.html or public pages
  if (isPublicPage && !isProtectedAgentPage) {
    return;
  }

  try {
    let userName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || 'Valued Agent';
    let agentCode = localStorage.getItem('currentAgentCode') || generateAgentCode();
    let walletBalance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0.00;

    // 1. Try to get Supabase session
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (user && !userError) {
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('full_name, agent_code')
          .eq('id', user.id)
          .single();

        if (profileData && !profileError) {
          if (profileData.full_name) userName = profileData.full_name;
          if (profileData.agent_code) agentCode = profileData.agent_code;
        }

        const { data: walletData, error: walletError } = await supabase
          .from('wallets')
          .select('balance')
          .eq('id', user.id)
          .single();

        if (walletData && !walletError && walletData.balance !== null && walletData.balance !== undefined) {
          walletBalance = parseFloat(walletData.balance);
        }
      } else if (isProtectedAgentPage) {
        window.location.href = 'login.html';
        return;
      }
    } catch (authErr) {
      console.error('Supabase auth check failed:', authErr);
      if (isProtectedAgentPage) {
        window.location.href = 'login.html';
        return;
      }
    }

    // Cache latest values
    localStorage.setItem('currentAgentName', userName);
    localStorage.setItem('agent_name', userName);
    localStorage.setItem('currentAgentCode', agentCode);
    localStorage.setItem('agent_wallet_balance', walletBalance);

    // Update UI elements across various dashboard pages
    const nameElement = document.getElementById('displayAgentName') || document.getElementById('userName');
    const codeElement = document.getElementById('displayAgentCode') || document.getElementById('agentCode');
    const avatarElement = document.getElementById('userAvatarInitials') || document.getElementById('walletAgentInitials');
    const popupBalElement = document.getElementById('popupBalanceVal');
    const balanceElement = document.getElementById('agentWalletBalance') || document.getElementById('walletPageBalance') || document.getElementById('walletHeaderDisplay') || document.getElementById('cashoutWalletBalDisplay');

    if (nameElement) nameElement.innerText = userName;
    if (codeElement) {
      codeElement.innerText = codeElement.id === 'displayAgentCode' ? `AGENT CODE: ${agentCode}` : agentCode;
    }
    if (popupBalElement) popupBalElement.innerText = `GHS ${walletBalance.toFixed(2)}`;
    if (balanceElement) {
      if (balanceElement.id === 'walletHeaderDisplay') {
        balanceElement.innerText = `Wallet Balance: GHS ${walletBalance.toFixed(2)}`;
      } else {
        balanceElement.innerText = `GHS ${walletBalance.toFixed(2)}`;
      }
    }

    if (avatarElement && userName) {
      const parts = userName.trim().split(/\s+/);
      let initials = 'AG';
      if (parts.length >= 2) {
        initials = parts[0][0] + parts[1][0];
      } else if (parts.length === 1 && parts[0].length > 0) {
        initials = parts[0].slice(0, 2);
      }
      avatarElement.innerText = initials.toUpperCase();
    }
  } catch (err) {
    console.error('Unexpected error in loadUserData:', err);
  }
}

// Execute on DOM load
document.addEventListener('DOMContentLoaded', loadUserData);
