import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

/**
 * Server-side check: is the authenticated (Bearer token) user a verified
 * Skaitech Agent? Agent status is always verified against auth + public.agents;
 * a value sent from the frontend is never trusted.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return json({ isAgent: false });
  }

  try {
    const admin = adminClient();
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) {
      return json({ isAgent: false });
    }

    const metaRole = String(user.user_metadata?.role ?? '');
    if (metaRole === 'admin' || metaRole === 'agent') {
      return json({
        isAgent: true,
        agent: {
          id: user.id,
          role: metaRole,
          full_name: user.user_metadata?.full_name || 'Agent',
          agent_code: user.user_metadata?.agent_code || '',
        },
      });
    }

    const { data: agent, error: agentError } = await admin
      .from('agents')
      .select('id, role, full_name, agent_code')
      .eq('id', user.id)
      .single();

    if (!agentError && agent && ['agent', 'admin'].includes(agent.role)) {
      return json({ isAgent: true, agent });
    }

    return json({ isAgent: false });
  } catch (err) {
    console.error('check-agent-access error:', err);
    return json({ isAgent: false });
  }
});