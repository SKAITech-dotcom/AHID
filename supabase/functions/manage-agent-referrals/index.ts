import { adminClient, corsPreflight, json, requireAdmin, requireAgent } from '../_shared/supabase.ts';

const PUBLIC_SITE = 'https://skaitechgh.com';

function text(value: unknown, max = 160): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeCode(value: unknown): string {
  return text(value, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

async function loadAgentSummary(agentId: string) {
  const admin = adminClient();
  const [{ data: agent, error: agentError }, { data: referrals, error: referralsError }, { data: rewards, error: rewardsError }] = await Promise.all([
    admin.from('agents').select('id, full_name, phone, agent_code').eq('id', agentId).maybeSingle(),
    admin.from('agent_referrals')
      .select('id, referral_code, status, source, created_at, qualified_at')
      .eq('referrer_agent_id', agentId)
      .order('created_at', { ascending: false }),
    admin.from('agent_referral_rewards')
      .select('id, referral_count, referrals_covered, amount, reason, wallet_transaction_reference, created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false }),
  ]);
  if (agentError) throw agentError;
  if (referralsError) throw referralsError;
  if (rewardsError) throw rewardsError;

  const qualified = (referrals || []).filter((row) => row.status === 'qualified');
  const rewardTotal = (rewards || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  let code = normalizeCode(agent?.agent_code);
  if (!code && agent?.id) {
    const generatedCode = `AG${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const { error: codeError } = await admin.from('agents').update({ agent_code: generatedCode }).eq('id', agent.id);
    if (!codeError) code = generatedCode;
  }
  return {
    success: true,
    referralCode: code,
    referralLink: code ? `${PUBLIC_SITE}/login.html?register=true&ref=${encodeURIComponent(code)}` : '',
    count: qualified.length,
    referrals: referrals || [],
    rewards: rewards || [],
    rewardTotal: Math.round(rewardTotal * 100) / 100,
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const admin = adminClient();

    if (request.method === 'GET') {
      const { user } = await requireAgent(request);
      return json(await loadAgentSummary(user.id));
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = text(body.action, 40).toLowerCase();

    // supabase.functions.invoke() defaults to POST when the caller does not
    // pass a method. Treat an empty POST like the read-only agent summary so an
    // older cached referral page cannot surface a generic non-2xx error.
    if (!action) {
      const { user } = await requireAgent(request);
      return json(await loadAgentSummary(user.id));
    }

    if (action === 'record') {
      const { user } = await requireAgent(request);
      const referralCode = normalizeCode(body.referralCode);
      if (!referralCode) return json({ success: true, recorded: false, reason: 'missing_code' });

      const { data: referrer, error: referrerError } = await admin
        .from('agents')
        .select('id, agent_code, status, is_active')
        .eq('agent_code', referralCode)
        .maybeSingle();
      if (referrerError) throw referrerError;
      if (!referrer || referrer.is_active === false || String(referrer.status || 'active') !== 'active') {
        return json({ success: true, recorded: false, reason: 'referrer_not_found' });
      }
      if (referrer.id === user.id) return json({ success: true, recorded: false, reason: 'self_referral' });

      const { data: existing, error: existingError } = await admin
        .from('agent_referrals')
        .select('id, referrer_agent_id')
        .eq('referred_agent_id', user.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) return json({ success: true, recorded: false, reason: 'already_attributed' });

      const { error } = await admin.from('agent_referrals').insert({
        referrer_agent_id: referrer.id,
        referred_agent_id: user.id,
        referral_code: referralCode,
        status: 'qualified',
        source: 'signup',
        qualified_at: new Date().toISOString(),
      });
      if (error) {
        if (error.code === '23505') return json({ success: true, recorded: false, reason: 'already_attributed' });
        throw error;
      }
      return json({ success: true, recorded: true });
    }

    if (action === 'admin-list') {
      const { user: adminUser } = await requireAdmin(request);
      const [{ data: agents, error: agentsError }, { data: referrals, error: referralsError }, { data: rewards, error: rewardsError }] = await Promise.all([
        admin.from('agents').select('id, full_name, phone, agent_code, status, is_active').order('created_at', { ascending: false }),
        admin.from('agent_referrals').select('id, referrer_agent_id, referred_agent_id, referral_code, status, created_at, qualified_at').order('created_at', { ascending: false }),
        admin.from('agent_referral_rewards').select('agent_id, referral_count, referrals_covered, amount, reason, created_at').order('created_at', { ascending: false }),
      ]);
      if (agentsError) throw agentsError;
      if (referralsError) throw referralsError;
      if (rewardsError) throw rewardsError;

      const counts = new Map<string, number>();
      const lastReferral = new Map<string, string>();
      for (const row of referrals || []) {
        if (row.status !== 'qualified') continue;
        counts.set(row.referrer_agent_id, (counts.get(row.referrer_agent_id) || 0) + 1);
        if (!lastReferral.has(row.referrer_agent_id)) lastReferral.set(row.referrer_agent_id, row.created_at);
      }
      const rewardMap = new Map<string, { count: number; amount: number }>();
      for (const row of rewards || []) {
        const current = rewardMap.get(row.agent_id) || { count: 0, amount: 0 };
        current.count = Math.max(current.count, Number(row.referral_count || 0));
        current.amount += Number(row.amount || 0);
        rewardMap.set(row.agent_id, current);
      }
      return json({
        success: true,
        agents: (agents || []).map((agent) => ({
          ...agent,
          referralCount: counts.get(agent.id) || 0,
          rewardedReferralCount: rewardMap.get(agent.id)?.count || 0,
          rewardTotal: Math.round((rewardMap.get(agent.id)?.amount || 0) * 100) / 100,
          lastReferralAt: lastReferral.get(agent.id) || null,
        })),
        referralCount: (referrals || []).filter((row) => row.status === 'qualified').length,
        requestedBy: adminUser.id,
      });
    }

    if (action === 'reward') {
      const { user: adminUser } = await requireAdmin(request);
      const agentId = text(body.agentId, 80);
      const amount = Number(body.amount);
      const reason = text(body.reason, 240) || 'Referral reward';
      if (!agentId || !Number.isFinite(amount) || amount <= 0) {
        return json({ error: 'Agent and a positive reward amount are required.' }, 400);
      }
      const { data, error } = await admin.rpc('admin_reward_agent_referrals', {
        p_agent_id: agentId,
        p_amount: Math.round(amount * 100) / 100,
        p_reason: reason,
        p_admin_id: adminUser.id,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, data });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error('manage-agent-referrals failed:', error);
    return json({ error: error instanceof Error ? error.message : 'Referral operation failed.' }, 500);
  }
});
