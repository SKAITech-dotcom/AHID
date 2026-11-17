-- Durable agent referral attribution and audited referral rewards.
-- A referral is counted only after the referred account has authenticated and
-- the record has been written by the protected manage-agent-referrals function.

create table if not exists public.agent_referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_agent_id uuid not null references public.agents(id) on delete cascade,
  referred_agent_id uuid not null unique references public.agents(id) on delete cascade,
  referral_code text not null,
  status text not null default 'qualified' check (status in ('qualified', 'reversed')),
  source text not null default 'signup' check (source in ('signup', 'manual')),
  created_at timestamptz not null default now(),
  qualified_at timestamptz not null default now()
);

create index if not exists agent_referrals_referrer_idx
  on public.agent_referrals(referrer_agent_id, status, created_at desc);
create index if not exists agent_referrals_code_idx
  on public.agent_referrals(referral_code);

create table if not exists public.agent_referral_rewards (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  referral_count integer not null check (referral_count > 0),
  referrals_covered integer not null check (referrals_covered > 0),
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,
  admin_id uuid references auth.users(id) on delete set null,
  wallet_transaction_reference text,
  created_at timestamptz not null default now(),
  unique (agent_id, referral_count)
);

create index if not exists agent_referral_rewards_agent_idx
  on public.agent_referral_rewards(agent_id, created_at desc);

alter table public.agent_referrals enable row level security;
alter table public.agent_referral_rewards enable row level security;
revoke all on public.agent_referrals from anon, authenticated;
revoke all on public.agent_referral_rewards from anon, authenticated;

-- The admin console uses this function through the service-role Edge Function.
-- It credits the same wallet and immutable ledgers used by manual admin credit,
-- and will not pay the same cumulative referral count twice.
create or replace function public.admin_reward_agent_referrals(
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrals integer;
  v_already_rewarded integer;
  v_before numeric;
  v_after numeric;
  v_ref text;
  v_agent_code text;
  v_reward_id uuid;
begin
  if not exists (
    select 1 from public.agents
    where id = p_admin_id and role in ('admin', 'super_admin') and coalesce(is_active, true) = true
  ) then
    raise exception 'Unauthorized. Administrator privilege required.';
  end if;
  if not exists (select 1 from public.agents where id = p_agent_id) then
    raise exception 'Agent not found.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Reward amount must be a positive amount with at most two decimals.';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reward reason is required.';
  end if;

  select count(*)::integer into v_referrals
  from public.agent_referrals
  where referrer_agent_id = p_agent_id and status = 'qualified';

  select coalesce(max(referral_count), 0)::integer into v_already_rewarded
  from public.agent_referral_rewards
  where agent_id = p_agent_id;

  if v_referrals <= v_already_rewarded then
    raise exception 'There are no new qualified referrals to reward.';
  end if;

  insert into public.wallets (id, balance)
  values (p_agent_id, 0)
  on conflict (id) do nothing;

  select coalesce(balance, 0) into v_before
  from public.wallets
  where id = p_agent_id
  for update;
  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  v_after := v_before + round(p_amount, 2);
  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;
  v_ref := 'REF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into public.transactions
    (agent_id, agent_code, reference, type, amount, balance_before, balance_after, description, status, metadata)
  values
    (p_agent_id, v_agent_code, v_ref, 'Referral Reward', round(p_amount, 2), v_before, v_after,
      trim(p_reason), 'completed', jsonb_build_object('admin_id', p_admin_id, 'referral_reward', true));

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (p_agent_id, v_ref, 'credit', trim(p_reason), round(p_amount, 2), v_after, 'settled',
      jsonb_build_object('admin_id', p_admin_id, 'referral_reward', true, 'signed_delta', round(p_amount, 2)));

  insert into public.agent_referral_rewards
    (agent_id, referral_count, referrals_covered, amount, reason, admin_id, wallet_transaction_reference)
  values
    (p_agent_id, v_referrals, v_referrals - v_already_rewarded, round(p_amount, 2), trim(p_reason), p_admin_id, v_ref)
  returning id into v_reward_id;

  perform public.log_activity(
    'Referral reward of GHS ' || round(p_amount, 2) || ' for agent ' || coalesce(v_agent_code, p_agent_id::text),
    jsonb_build_object('agent_id', p_agent_id, 'amount', round(p_amount, 2),
      'referral_count', v_referrals, 'referrals_covered', v_referrals - v_already_rewarded,
      'reason', trim(p_reason), 'reference', v_ref), p_admin_id);

  return jsonb_build_object(
    'success', true,
    'rewardId', v_reward_id,
    'referralCount', v_referrals,
    'referralsCovered', v_referrals - v_already_rewarded,
    'amount', round(p_amount, 2),
    'reference', v_ref,
    'newBalance', v_after
  );
end;
$$;

revoke all on function public.admin_reward_agent_referrals(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_reward_agent_referrals(uuid, numeric, text, uuid) to service_role;
