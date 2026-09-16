import { supabase } from './supabaseClient.js';

/**
 * Validates that the current visitor has an active Supabase session AND
 * a verified 'agent' or 'admin' role in the public.agents table.
 * If unauthorized, immediately redirects them away from protected agent areas.
 *
 * @param {Object} options
 * @param {boolean} options.redirectOnFail - whether to redirect if unauthorized (default: true)
 * @param {string} options.redirectTarget - where to redirect if unauthorized (default: 'login.html')
 * @returns {Promise<{ user: any, agent: any } | null>}
 */
export async function requireVerifiedAgent(options = {}) {
  const redirectOnFail = options.redirectOnFail !== false;
  const currentPath = window.location.pathname;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      if (redirectOnFail) {
        sessionStorage.setItem('skaitech_return_url', currentPath);
        window.location.href = 'login.html';
      }
      return null;
    }

    // Verify role in the public.agents table
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, role, full_name, agent_code, phone')
      .eq('id', user.id)
      .single();

    if (agentError || !agent || !['agent', 'admin'].includes(agent.role)) {
      console.warn('Unauthorized agent access attempt:', user.id, agent);
      // Clean up agent state
      localStorage.removeItem('currentAgentCode');
      localStorage.removeItem('agent_wallet_balance');

      if (redirectOnFail) {
        alert('Access Denied: This portal requires a verified Skaitech Agent account.');
        window.location.href = 'index.html';
      }
      return null;
    }

    // Store verified agent credentials
    localStorage.setItem('currentAgentName', agent.full_name || user.email.split('@')[0]);
    localStorage.setItem('agent_name', agent.full_name || user.email.split('@')[0]);
    if (agent.agent_code) localStorage.setItem('currentAgentCode', agent.agent_code);
    localStorage.setItem('agent_role', agent.role);

    return { user, agent };
  } catch (err) {
    console.error('Agent verification failed:', err);
    if (redirectOnFail) {
      window.location.href = 'login.html';
    }
    return null;
  }
}
