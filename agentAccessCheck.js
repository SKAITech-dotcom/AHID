import { supabase } from './supabaseClient.js';

/**
 * Server-verified agent check. Agent status is confirmed on the backend
 * (supabase/functions/check-agent-access) against auth + the public.agents
 * table. The client never decides whether someone is an agent; it only
 * reports what the server returns.
 *
 * @returns {Promise<{ isAgent: boolean, agent: Object|null }>}
 */
export async function checkAgentAccessServer() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return { isAgent: false, agent: null };
    }

    const { data, error } = await supabase.functions.invoke('check-agent-access', {
      body: {},
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (error || !data || data.isAgent !== true) {
      return { isAgent: false, agent: null };
    }

    return { isAgent: true, agent: data.agent || null };
  } catch (err) {
    console.warn('Server agent check failed:', err);
    return { isAgent: false, agent: null };
  }
}

/**
 * Calls the server-scoped agent-transactions function.
 * @returns {Promise<{ success: boolean, airtime: Array, utility: Array, summary: Object } | null>}
 */
export async function fetchAgentTransactions() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return null;
    }
    const { data, error } = await supabase.functions.invoke('agent-transactions', {
      body: {},
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error || !data?.success) {
      console.warn('Agent transactions fetch failed:', error || data);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('Agent transactions fetch error:', err);
    return null;
  }
}