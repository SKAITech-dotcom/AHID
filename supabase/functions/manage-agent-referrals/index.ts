import { adminClient, corsPreflight, json, requireAdmin, requireAgent } from '../_shared/supabase.ts';

const PUBLIC_SITE = 'https://skaitechgh.com';

function text(value: unknown, max = 160): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeCode(value: unknown): string {
  return text(value, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function normalizeSlug(value: unknown): string {
  return text(value, 80)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function fallbackSlug(name: unknown, agentId: string): string {
  const base = normalizeSlug(name) || 'agent';
  const suffix = agentId.replace(/-/g, '').slice(0, 8);
  return `${base.slice(0, Math.max(1, 80 - suffix.length - 1))}-${suffix}`;
}

async function loadAgentSummary(agentId: string) {
  const admin = adminClient();
  const [{ data: agent, error: agentError }, { data: referrals, error: referralsError }, { data: rewards, error: rewardsError }, { data: awards, error: awardsError }, { data: wallet, error: walletError }] = await Promise.all([
    admin.from('agents').select('id, full_name, phone, agent_code, referral_slug').eq('id', agentId).maybeSingle(),
    admin.from('agent_referrals').select('id, referral_code, status, source, created_at, qualified_at, referred_agent_id').eq('referrer_agent_id', agentId).order('created_at', { ascending: false }),
    admin.from('agent_referral_rewards').select('id, referral_count, referrals_covered, amount, reason, wallet_transaction_reference, created_at').eq('agent_id', agentId).order('created_at', { ascending: false }),
    admin.from('agent_referral_awards').select('id, referral_id, referred_agent_id, amount, status, reason, audit_reference, paid_reference, paid_note, paid_at, created_at').eq('agent_id', agentId).order('created_at', { ascending: false }),
    admin.from('wallets').select('referral_balance, total_referral_earned, transferred_referral_rewards, paid_referral_rewards').eq('id', agentId).maybeSingle(),
  ]);
  if (agentError) throw agentError;
  if (referralsError) throw referralsError;
  if (rewardsError) throw rewardsError;
  if (awardsError) throw awardsError;
  if (walletError) throw walletError;

  const referredIds = [...new Set((referrals || []).map((row) => row.referred_agent_id).filter(Boolean))];
  const { data: referredAgents, error: referredAgentsError } = referredIds.length
    ? await admin.from('agents').select('id, full_name, phone, agent_code, created_at').in('id', referredIds)
    : { data: [], error: null };
  if (referredAgentsError) throw referredAgentsError;

  const referredMap = new Map((referredAgents || []).map((row) => [row.id, row]));
  const awardMap = new Map((awards || []).map((row) => [row.referral_id, row]));
  const qualified = (referrals || []).filter((row) => row.status === 'qualified');
  const rewardTotal = (rewards || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
    + (awards || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);

  let code = normalizeCode(agent?.agent_code);
  if (!code && agent?.id) {
    const generatedCode = `AG${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const { error: codeError } = await admin.from('agents').update({ agent_code: generatedCode }).eq('id', agent.id);
    if (!codeError) code = generatedCode;
  }
  let slug = normalizeSlug(agent?.referral_slug);
  if (!slug && agent?.id) {
    const generatedSlug = fallbackSlug(agent.full_name, agent.id);
    const { error: slugError } = await admin.from('agents').update({ referral_slug: generatedSlug }).eq('id', agent.id);
    if (!slugError) slug = generatedSlug;
  }

  return {
    success: true,
    referralCode: code,
    referralSlug: slug,
    referralLink: slug ? `${PUBLIC_SITE}/login.html?register=true&ref=${encodeURIComponent(slug)}` : '',
    count: qualified.length,
    referrals: (referrals || []).map((row) => ({ ...row, referredAgent: referredMap.get(row.referred_agent_id) || null, award: awardMap.get(row.id) || null })),
    rewards: rewards || [],
    awards: awards || [],
    rewardTotal: Math.round(rewardTotal * 100) / 100,
    rewardedReferralCount: (awards || []).length,
    referralBalance: Number(wallet?.referral_balance || 0),
    totalReferralEarned: Number(wallet?.total_referral_earned || 0),
    transferredReferralRewards: Number(wallet?.transferred_referral_rewards || 0),
    paidReferralRewards: Number(wallet?.paid_referral_rewards || 0),
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
    if (!action) {
      const { user } = await requireAgent(request);
      return json(await loadAgentSummary(user.id));
    }

    if (action === 'record') {
      const { user } = await requireAgent(request);
      const referralSlug = normalizeSlug(body.referralSlug);
      const referralCode = normalizeCode(body.referralCode);
      if (!referralSlug && !referralCode) return json({ success: true, recorded: false, reason: 'missing_referral' });

      let referrer: any = null;
      let referrerError: any = null;
      if (referralSlug) {
        ({ data: referrer, error: referrerError } = await admin.from('agents').select('id, agent_code, referral_slug, status, is_active').eq('referral_slug', referralSlug).maybeSingle());
      }
      if (referrerError) throw referrerError;
      if (!referrer && referralCode) {
        ({ data: referrer, error: referrerError } = await admin.from('agents').select('id, agent_code, referral_slug, status, is_active').eq('agent_code', referralCode).maybeSingle());
        if (referrerError) throw referrerError;
      }
      if (!referrer || referrer.is_active === false || String(referrer.status || 'active') !== 'active') return json({ success: true, recorded: false, reason: 'referrer_not_found' });
      if (referrer.id === user.id) return json({ success: true, recorded: false, reason: 'self_referral' });

      const { data: existing, error: existingError } = await admin.from('agent_referrals').select('id, referrer_agent_id').eq('referred_agent_id', user.id).maybeSingle();
      if (existingError) throw existingError;
      if (existing) return json({ success: true, recorded: false, reason: 'already_attributed' });

      const { error } = await admin.from('agent_referrals').insert({
        referrer_agent_id: referrer.id,
        referred_agent_id: user.id,
        referral_code: referrer.referral_slug || referralSlug || referralCode,
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
      const [{ data: agents, error: agentsError }, { data: referrals, error: referralsError }, { data: rewards, error: rewardsError }, { data: awards, error: awardsError }, { data: wallets, error: walletsError }] = await Promise.all([
        admin.from('agents').select('id, full_name, phone, agent_code, referral_slug, status, is_active, created_at').order('created_at', { ascending: false }),
        admin.from('agent_referrals').select('id, referrer_agent_id, referred_agent_id, referral_code, status, source, created_at, qualified_at').order('created_at', { ascending: false }),
        admin.from('agent_referral_rewards').select('agent_id, referral_count, referrals_covered, amount, reason, created_at').order('created_at', { ascending: false }),
        admin.from('agent_referral_awards').select('id, referral_id, agent_id, referred_agent_id, amount, status, reason, audit_reference, paid_reference, paid_note, paid_at, created_at').order('created_at', { ascending: false }),
        admin.from('wallets').select('id, referral_balance, total_referral_earned, transferred_referral_rewards, paid_referral_rewards'),
      ]);
      if (agentsError) throw agentsError;
      if (referralsError) throw referralsError;
      if (rewardsError) throw rewardsError;
      if (awardsError) throw awardsError;
      if (walletsError) throw walletsError;

      const agentMap = new Map((agents || []).map((agent) => [agent.id, agent]));
      const awardMap = new Map((awards || []).map((award) => [award.referral_id, award]));
      const walletMap = new Map((wallets || []).map((wallet) => [wallet.id, wallet]));
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
        agents: (agents || []).map((agent) => {
          const agentAwards = (awards || []).filter((award) => award.agent_id === agent.id);
          const wallet = walletMap.get(agent.id) || {};
          const legacy = rewardMap.get(agent.id);
          return {
            ...agent,
            referralCount: counts.get(agent.id) || 0,
            rewardedReferralCount: agentAwards.length || legacy?.count || 0,
            rewardTotal: Math.round(((legacy?.amount || 0) + agentAwards.reduce((sum, award) => sum + Number(award.amount || 0), 0)) * 100) / 100,
            lastReferralAt: lastReferral.get(agent.id) || null,
            referralBalance: Number(wallet.referral_balance || 0),
            totalReferralEarned: Number(wallet.total_referral_earned || 0),
            transferredReferralRewards: Number(wallet.transferred_referral_rewards || 0),
            paidReferralRewards: Number(wallet.paid_referral_rewards || 0),
            referrals: (referrals || []).filter((referral) => referral.referrer_agent_id === agent.id).map((referral) => ({
              ...referral,
              referredAgent: agentMap.get(referral.referred_agent_id) || null,
              award: awardMap.get(referral.id) || null,
            })),
          };
        }),
        referralCount: (referrals || []).filter((row) => row.status === 'qualified').length,
        requestedBy: adminUser.id,
      });
    }

    if (action === 'transfer') {
      const { user } = await requireAgent(request);
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Enter a positive referral transfer amount.' }, 400);
      const { data, error } = await admin.rpc('transfer_referral_rewards', { p_agent_id: user.id, p_amount: Math.round(amount * 100) / 100 });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, data });
    }

    if (action === 'reward' || action === 'award-referral') {
      const { user: adminUser } = await requireAdmin(request);
      const agentId = text(body.agentId, 80);
      const referralId = text(body.referralId, 80);
      const amount = Number(body.amount);
      const reason = text(body.reason, 240) || 'Referral reward';
      if (!agentId || !Number.isFinite(amount) || amount <= 0) return json({ error: 'Agent and a positive reward amount are required.' }, 400);
      if (referralId) {
        const { data, error } = await admin.rpc('admin_award_agent_referral', {
          p_referral_id: referralId,
          p_amount: Math.round(amount * 100) / 100,
          p_reason: reason,
          p_audit_reference: text(body.auditReference, 120),
          p_admin_id: adminUser.id,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ success: true, data });
      }
      const { data, error } = await admin.rpc('admin_reward_agent_referrals', { p_agent_id: agentId, p_amount: Math.round(amount * 100) / 100, p_reason: reason, p_admin_id: adminUser.id });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, data });
    }

    if (action === 'mark-paid') {
      const { user: adminUser } = await requireAdmin(request);
      const awardId = text(body.awardId, 80);
      if (!awardId) return json({ error: 'Reward award ID is required.' }, 400);
      const { data, error } = await admin.rpc('admin_mark_agent_referral_paid', {
        p_award_id: awardId,
        p_paid_reference: text(body.paidReference, 120),
        p_note: text(body.note, 240),
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
