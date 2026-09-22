import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

/**
 * Agent account settings: shows profile + last login, and lets an agent
 * update their personal details (name, phone, agent code) and credentials
 * (email / password) while staying inside the portal.
 */

let currentUser = null;

function showNotice(message, type) {
  const el = document.getElementById('settingsNotice');
  if (!el) return;
  el.className = `settings-notice show ${type}`;
  el.textContent = message;
  clearTimeout(showNotice._t);
  showNotice._t = setTimeout(() => el.classList.remove('show'), 6000);
}

function formatLastLogin(value) {
  if (!value) return 'First session';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function loadDetail(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '—';
}

function fillForm(user, agent) {
  loadDetail('ovFullName', (agent && agent.full_name) || user.user_metadata?.full_name || '');
  loadDetail('ovAgentCode', (agent && agent.agent_code) || user.user_metadata?.agent_code || '');
  loadDetail('ovEmail', user.email || '');
  loadDetail('ovPhone', (agent && agent.phone) || user.user_metadata?.phone || '');
  loadDetail('ovRole', (agent && agent.role) || user.user_metadata?.role || 'agent');
  loadDetail('ovLastLogin', formatLastLogin(user.last_sign_in_at));

  const nameEl = document.getElementById('setFullName');
  const phoneEl = document.getElementById('setPhone');
  const codeEl = document.getElementById('setAgentCode');
  const emailEl = document.getElementById('setEmail');
  if (nameEl) nameEl.value = (agent && agent.full_name) || user.user_metadata?.full_name || '';
  if (phoneEl) phoneEl.value = (agent && agent.phone) || user.user_metadata?.phone || '';
  if (codeEl) codeEl.value = (agent && agent.agent_code) || user.user_metadata?.agent_code || '';
  if (emailEl) emailEl.value = user.email || '';
}

async function loadAccount() {
  const authResult = await requireVerifiedAgent({ redirectOnFail: true });
  if (!authResult) return;
  currentUser = authResult.user;

  let agent = authResult.agent;
  try {
    const { data } = await supabase
      .from('agents')
      .select('id, role, full_name, agent_code, phone')
      .eq('id', currentUser.id)
      .single();
    if (data) agent = data;
  } catch (err) {
    console.warn('Could not refresh agent row for settings:', err);
  }

  fillForm(currentUser, agent);
}

async function handleSaveDetails() {
  const name = (document.getElementById('setFullName').value || '').trim();
  const phone = (document.getElementById('setPhone').value || '').trim();
  const code = (document.getElementById('setAgentCode').value || '').trim();

  if (!canSave()) return;
  if (!name) {
    showNotice('Full name cannot be empty.', 'error');
    return;
  }

  const btn = document.getElementById('saveDetailsBtn');
  btn.disabled = true;

  try {
    const payload = { full_name: name, phone, agent_code: code };
    const [profilesResult, agentsResult] = await Promise.all([
      supabase.from('profiles').upsert({ id: currentUser.id, ...payload }, { onConflict: 'id' }),
      supabase.from('agents').upsert({ id: currentUser.id, ...payload }, { onConflict: 'id' }),
    ]);

    if (profilesResult.error || agentsResult.error) {
      throw new Error(profilesResult.error?.message || agentsResult.error?.message || 'Unable to save details.');
    }

    await supabase.auth.updateUser({ data: payload });

    localStorage.setItem('currentAgentName', name);
    localStorage.setItem('agent_name', name);
    if (code) localStorage.setItem('currentAgentCode', code);

    loadDetail('ovFullName', name);
    loadDetail('ovAgentCode', code);
    loadDetail('ovPhone', phone);

    showNotice('Your details have been updated.', 'success');
  } catch (err) {
    console.error('Save details failed:', err);
    showNotice(err?.message || 'Unable to save details right now.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSaveCredentials() {
  const email = (document.getElementById('setEmail').value || '').trim();
  const password = document.getElementById('setPassword').value;
  const confirmPassword = document.getElementById('setConfirmPassword').value;

  if (!canSave()) return;

  if (!email && !password) {
    showNotice('Enter a new email or password before saving.', 'error');
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showNotice('Please enter a valid email address.', 'error');
    return;
  }
  if (password || confirmPassword) {
    if (password.length < 6) {
      showNotice('Password must be at least 6 characters long.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      showNotice('Passwords do not match.', 'error');
      return;
    }
  }

  const btn = document.getElementById('saveCredentialsBtn');
  btn.disabled = true;

  try {
    const { error } = await supabase.auth.updateUser({
      email: email || undefined,
      password: password || undefined,
    });
    if (error) throw error;

    showNotice('Credentials updated. Please sign in again to continue.', 'success');

    try {
      await supabase.auth.signOut();
    } catch (signOutErr) {
      console.warn('Sign-out after credential update failed:', signOutErr);
    }
    setTimeout(() => {
      window.location.href = 'login.html';
    }, 900);
  } catch (err) {
    console.error('Update credentials failed:', err);
    showNotice(err?.message || 'Unable to update credentials right now.', 'error');
    btn.disabled = false;
  }
}

function canSave() {
  return !!currentUser;
}

function bindEvents() {
  const detailsBtn = document.getElementById('saveDetailsBtn');
  const credentialsBtn = document.getElementById('saveCredentialsBtn');
  if (detailsBtn) detailsBtn.addEventListener('click', handleSaveDetails);
  if (credentialsBtn) credentialsBtn.addEventListener('click', handleSaveCredentials);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadAccount();
  });
} else {
  bindEvents();
  loadAccount();
}