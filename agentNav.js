import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';

/**
 * Unified, session-aware navigation shell for every Skaitech portal page.
 * Injected once per page to provide a consistent top header + slide-out
 * drawer. Behavior differs by session:
 *   - Verified agents: brand + nav point to dashboard/services (they stay
 *     inside the portal; there is no "Back to Home" that exits to the
 *     public landing page). Drawer includes Portal links + Sign Out.
 *   - Visitors: brand + "Home" keep them on the public site; drawer shows
 *     Agent Login / Become an Agent plus the same services.
 */

const LOGO = 'img/akaitech%20more%20final%20logo.jpeg';

const AGENT_PORTAL_ITEMS = [
  { page: 'dashboard.html', icon: 'fa-border-all', label: 'Dashboard' },
  { page: 'orders.html', icon: 'fa-cart-shopping', label: 'Orders' },
  { page: 'agentWallet.html', icon: 'fa-wallet', label: 'Wallet' },
  { page: 'deposit.html', icon: 'fa-money-bill-transfer', label: 'Deposit' },
  { page: 'agentAFA.HTML', icon: 'fa-users', label: 'Agent AFA' },
  { page: 'STORE.HTML', icon: 'fa-store', label: 'Store & Pricing' },
  { page: 'settings.html', icon: 'fa-user-gear', label: 'Settings' },
];

const SERVICE_ITEMS = [
  { page: 'airtime.html', icon: 'fa-mobile-screen-button', label: 'Buy Airtime' },
  { page: 'instantData.html', icon: 'fa-wifi', label: 'Instant Data' },
  { page: 'utilityBills.html', icon: 'fa-bolt', label: 'Utility Bills' },
  { page: 'resultsChecker.html', icon: 'fa-receipt', label: 'Results Checker' },
  { page: 'nonAgentTrachOrder.html', icon: 'fa-magnifying-glass', label: 'Track Order' },
];

function currentFile() {
  const file = window.location.pathname.split('/').pop();
  return (file || 'index.html').toLowerCase();
}

function drawerItem(item, isAgent) {
  const ext = item.external ? ' target="_blank" rel="noopener"' : '';
  const href = item.href || item.page;
  const active = item.page && currentFile() === item.page.toLowerCase() ? ' active' : '';
  return `
    <a href="${href}" class="drawer-item${active ? ' active' : ''}"${ext}>
      <i class="fa-solid ${item.icon}"></i> ${item.label}
    </a>`;
}

function drawerHtml(isAgent) {
  const portal = isAgent
    ? AGENT_PORTAL_ITEMS.map((i) => drawerItem(i, true)).join('')
    : `
      <a href="login.html" class="drawer-item">
        <i class="fa-solid fa-right-to-bracket"></i> Agent Login
      </a>
      <a href="login.html?register=true" class="drawer-item">
        <i class="fa-solid fa-user-plus"></i> Become an Agent
      </a>`;

  const logoutAction = isAgent
    ? `
      <div class="drawer-divider"></div>
      <span class="drawer-section-label">SESSION</span>
      <nav class="drawer-nav">
        <button type="button" onclick="agentShellLogout()" class="drawer-item" style="background: none; border: none; width: 100%; text-align: left; cursor: pointer; color: #dc2626;">
          <i class="fa-solid fa-right-from-bracket"></i> Sign Out
        </button>
      </nav>`
    : '';

  return `
    <div class="drawer-header">
      <div class="drawer-brand">
        <img src="${LOGO}" alt="Skaitech" class="drawer-logo">
        <span class="drawer-brand-name">SKAITECH</span>
      </div>
      <button type="button" class="drawer-close-btn" onclick="toggleAgentDrawer()" aria-label="Close menu">&times;</button>
    </div>

    <span class="drawer-section-label">${isAgent ? 'AGENT PORTAL' : 'SKAITECH'}</span>
    <nav class="drawer-nav">
      ${isAgent ? '' : `<a href="index.html" class="drawer-item"><i class="fa-solid fa-house"></i> Home</a>`}
      ${portal}
    </nav>

    <div class="drawer-divider"></div>

    <span class="drawer-section-label">SERVICES</span>
    <nav class="drawer-nav">
      ${SERVICE_ITEMS.map((i) => drawerItem(i, isAgent)).join('')}
    </nav>

    <div class="drawer-divider"></div>

    <span class="drawer-section-label">SUPPORT</span>
    <nav class="drawer-nav">
      <a href="ourHelpDesk.html" class="drawer-item">
        <i class="fa-solid fa-headset"></i> Our Help Desk
      </a>
      <a href="https://chat.whatsapp.com/EbflGFoh9Y64BiaFVqbHid" target="_blank" rel="noopener" class="drawer-item">
        <i class="fa-brands fa-whatsapp"></i> Community
      </a>
    </nav>
    ${logoutAction}
  `;
}

function headerHtml(isAgent) {
  const userInitials = (localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || '').trim() || 'AG';
  const initials = userInitials.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'AG';

  return `
    <div class="gt-header-left">
      <button type="button" class="gt-hamburger-btn hamburger-btn" onclick="toggleAgentDrawer()" aria-label="Open menu">
        <i class="fa-solid fa-bars"></i>
      </button>
      <a href="${isAgent ? 'dashboard.html' : 'index.html'}" class="gt-brand" style="text-decoration: none;">
        SKAITECH
      </a>
    </div>
    <div class="gt-header-right">
      ${isAgent
        ? `<span class="agent-portal-tag"><i class="fa-solid fa-user-check"></i> Agent Portal</span>
           <div class="user-avatar" id="agentShellAvatar">${initials}</div>`
        : `<a href="login.html" class="agent-login-link"><i class="fa-solid fa-right-to-bracket"></i> Agent Login</a>`}
    </div>
  `;
}

async function loadShell(isAgent) {
  const header = document.getElementById('agentShellHeader');
  if (header) {
    header.innerHTML = headerHtml(isAgent, true);
  }
  const drawer = document.getElementById('agentShellDrawer');
  if (drawer) {
    drawer.innerHTML = drawerHtml(isAgent);
  }
}

function ensureElements() {
  let header = document.getElementById('agentShellHeader');
  let overlay = document.getElementById('agentShellOverlay');
  let drawer = document.getElementById('agentShellDrawer');

  if (!header) {
    header = document.createElement('header');
    header.id = 'agentShellHeader';
    header.className = 'gt-header';
    header.style.cssText = 'position: sticky; top: 0; z-index: 100;';
    document.body.insertBefore(header, document.body.firstChild);
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'agentShellOverlay';
    overlay.className = 'sidebar-overlay';
    overlay.onclick = () => toggleAgentDrawer();
    document.body.appendChild(overlay);
  }

  if (!drawer) {
    drawer = document.createElement('aside');
    drawer.id = 'agentShellDrawer';
    drawer.className = 'side-drawer';
    document.body.appendChild(drawer);
  }

  return { header, overlay, drawer };
}

function toggleAgentDrawer(force) {
  const drawer = document.getElementById('agentShellDrawer');
  const overlay = document.getElementById('agentShellOverlay');
  if (!drawer) return;
  const open = typeof force === 'boolean' ? force : !drawer.classList.contains('active');
  drawer.classList.toggle('active', open);
  if (overlay) overlay.classList.toggle('active', open);
}

async function agentShellLogout() {
  try { await supabase.auth.signOut(); } catch (err) { console.warn('Sign out notice:', err); }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch (err) { /* ignore */ }
  window.location.href = 'login.html';
}

async function initAgentShell() {
  const { overlay, drawer } = ensureElements();
  drawer.classList.add('side-drawer');
  drawer.id = 'agentShellDrawer';

  let isAgent = false;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      // Prefer server-verified status; fall back to cached flag.
      isAgent = !!localStorage.getItem('currentAgentCode') ||
                ['agent', 'admin'].includes(localStorage.getItem('agent_role') || '');
      try {
        const res = await checkAgentAccessServer();
        if (res && typeof res.isAgent === 'boolean') isAgent = res.isAgent;
      } catch (err) {
        console.warn('Server agent check unavailable; using cached flag:', err);
      }
    }
  } catch (err) {
    console.warn('Session check unavailable:', err);
  }

  await loadShell(isAgent);
  document.body.classList.add('agent-shell-mounted');
  document.body.classList.toggle('agent-shell-agent', isAgent);
}

window.toggleAgentDrawer = toggleAgentDrawer;
// Some legacy pages still call toggleDrawer(); expose a safe alias.
if (typeof window.toggleDrawer !== 'function') {
  window.toggleDrawer = toggleAgentDrawer;
}
window.agentShellLogout = agentShellLogout;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAgentShell);
} else {
  initAgentShell();
}
