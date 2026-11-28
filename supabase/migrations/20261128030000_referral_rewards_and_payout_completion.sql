-- End-to-end referral rewards and commission payout visibility.
-- Referral rewards use their own balance so they cannot be confused with
-- store commission or customer-funded spendable wallet money.

alter table public.wallets
  add column if not exists referral_balance numeric(12,2) not null default 0,
  add column if not exists total_referral_earned numeric(12,2) not null default 0,
  add column if not exists transferred_referral_rewards numeric(12,2) not null default 0,
  add column if not exists paid_referral_rewards numeric(12,2) not null default 0;

create table if not exists public.agent_referral_awards (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null unique references public.agent_referrals(id) on delete restrict,
  agent_id uuid not null references auth.users(id) on delete restrict,
  referred_agent_id uuid not null references auth.users(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'credited' check (status in ('credited', 'paid', 'reversed')),
  reason text not null default 'Referral reward',
  audit_reference text not null unique,
  wallet_transaction_reference text unique,
  admin_id uuid references auth.users(id) on delete set null,
  paid_reference text,
  paid_note text,
  paid_at timestamptz,
  paid_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_referral_awards_agent_created_idx
  on public.agent_referral_awards(agent_id, created_at desc);
create index if not exists agent_referral_awards_status_idx
  on public.agent_referral_awards(status, created_at desc);

alter table public.agent_referral_awards enable row level security;
revoke all on public.agent_referral_awards from anon, authenticated;

create or replace function public.admin_award_agent_referral(
  p_referral_id uuid,
  p_amount numeric,
  p_reason text default 'Referral reward',
  p_audit_reference text default '',
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral public.agent_referrals%rowtype;
  v_award public.agent_referral_awards%rowtype;
  v_wallet public.wallets%rowtype;
  v_amount numeric(12,2);
  v_audit text;
  v_wallet_ref text;
  v_before numeric(12,2);
  v_after numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;
  if p_referral_id is null then raise exception 'Referral ID is required.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Reward amount must be a positive amount with at most two decimals.';
  end if;
  v_amount := round(p_amount, 2);

  select * into v_referral
    from public.agent_referrals
   where id = p_referral_id
   for update;
  if not found then raise exception 'Referral not found.'; end if;
  if v_referral.status <> 'qualified' then
    raise exception 'Only qualified referrals can be rewarded.';
  end if;

  select * into v_award
    from public.agent_referral_awards
   where referral_id = p_referral_id
   for update;
  if found then
    raise exception 'This referral already has a reward award.';
  end if;

  insert into public.wallets (id) values (v_referral.referrer_agent_id)
  on conflict (id) do nothing;
  select * into v_wallet from public.wallets
   where id = v_referral.referrer_agent_id for update;
  if not found then raise exception 'Referring agent wallet not found.'; end if;

  v_audit := nullif(trim(coalesce(p_audit_reference, '')), '');
  if v_audit is null then
    v_audit := 'REF-AWARD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  end if;
  v_wallet_ref := 'REF-CREDIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  v_before := coalesce(v_wallet.referral_balance, 0);
  v_after := v_before + v_amount;

  update public.wallets
     set referral_balance = v_after,
         total_referral_earned = coalesce(total_referral_earned, 0) + v_amount,
         updated_at = now()
   where id = v_referral.referrer_agent_id;

  insert into public.agent_referral_awards
    (referral_id, agent_id, referred_agent_id, amount, reason, audit_reference,
     wallet_transaction_reference, admin_id)
  values
    (p_referral_id, v_referral.referrer_agent_id, v_referral.referred_agent_id,
     v_amount, coalesce(nullif(trim(p_reason), ''), 'Referral reward'), v_audit,
     v_wallet_ref, p_admin_id);

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (v_referral.referrer_agent_id, v_wallet_ref, 'credit', 'Referral reward credited',
     v_amount, coalesce(v_wallet.balance, 0), 'settled',
     jsonb_build_object('referral_id', p_referral_id, 'award_audit_reference', v_audit,
       'referral_balance_before', v_before, 'referral_balance_after', v_after,
       'admin_id', p_admin_id));

  insert into public.transactions
    (agent_id, reference, amount, type, description, balance_before, balance_after, status, metadata, created_at, updated_at)
  values
    (v_referral.referrer_agent_id, v_wallet_ref, v_amount, 'Referral Reward',
     coalesce(nullif(trim(p_reason), ''), 'Referral reward'), coalesce(v_wallet.balance, 0),
     coalesce(v_wallet.balance, 0), 'success',
     jsonb_build_object('referral_id', p_referral_id, 'audit_reference', v_audit,
       'referral_balance_after', v_after, 'admin_id', p_admin_id), now(), now());

  return jsonb_build_object(
    'success', true,
    'awardId', (select id from public.agent_referral_awards where referral_id = p_referral_id),
    'auditReference', v_audit,
    'amount', v_amount,
    'referralBalance', v_after
  );
exception
  when unique_violation then
    raise exception 'This referral already has a reward award or the audit reference is already in use.';
end;
$$;

create or replace function public.transfer_referral_rewards(
  p_agent_id uuid,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_amount numeric(12,2);
  v_ref text;
  v_referral_before numeric(12,2);
  v_referral_after numeric(12,2);
  v_balance_after numeric(12,2);
begin
  if p_agent_id is null then raise exception 'Agent ID is required.'; end if;
  if auth.uid() is distinct from p_agent_id and not public.is_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'You may only transfer your own referral rewards.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Transfer amount must be a positive amount with at most two decimals.';
  end if;
  v_amount := round(p_amount, 2);

  insert into public.wallets (id) values (p_agent_id) on conflict (id) do nothing;
  select * into v_wallet from public.wallets where id = p_agent_id for update;
  v_referral_before := coalesce(v_wallet.referral_balance, 0);
  if v_referral_before < v_amount then
    raise exception 'Insufficient referral balance. Available: GHS %', v_referral_before;
  end if;
  v_referral_after := v_referral_before - v_amount;
  v_balance_after := coalesce(v_wallet.balance, 0) + v_amount;
  v_ref := 'REF-TRANSFER-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  update public.wallets
     set referral_balance = v_referral_after,
         transferred_referral_rewards = coalesce(transferred_referral_rewards, 0) + v_amount,
         balance = v_balance_after,
         updated_at = now()
   where id = p_agent_id;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (p_agent_id, v_ref, 'credit', 'Referral rewards transferred to main wallet', v_amount,
     v_balance_after, 'settled', jsonb_build_object(
       'referral_balance_before', v_referral_before,
       'referral_balance_after', v_referral_after,
       'source', 'referral_rewards'));

  insert into public.transactions
    (agent_id, reference, amount, type, description, balance_before, balance_after, status, metadata, created_at, updated_at)
  values
    (p_agent_id, v_ref, v_amount, 'Referral Transfer',
     'Referral rewards transferred to main wallet', coalesce(v_wallet.balance, 0),
     v_balance_after, 'success', jsonb_build_object(
       'referral_balance_before', v_referral_before,
       'referral_balance_after', v_referral_after), now(), now());

  return jsonb_build_object('success', true, 'reference', v_ref, 'amount', v_amount,
    'referralBalance', v_referral_after, 'mainBalance', v_balance_after);
end;
$$;

create or replace function public.admin_mark_agent_referral_paid(
  p_award_id uuid,
  p_paid_reference text default '',
  p_note text default '',
  p_admin_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_award public.agent_referral_awards%rowtype;
  v_wallet public.wallets%rowtype;
  v_paid_ref text;
  v_tx_ref text;
  v_before numeric(12,2);
  v_after numeric(12,2);
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;
  select * into v_award from public.agent_referral_awards where id = p_award_id for update;
  if not found then raise exception 'Referral reward award not found.'; end if;
  if v_award.status = 'paid' then
    return jsonb_build_object('success', true, 'status', 'paid', 'awardId', v_award.id,
      'auditReference', v_award.audit_reference, 'amount', v_award.amount,
      'paidReference', v_award.paid_reference, 'alreadyPaid', true);
  end if;
  if v_award.status = 'reversed' then raise exception 'This referral reward has been reversed.'; end if;

  select * into v_wallet from public.wallets where id = v_award.agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  v_before := coalesce(v_wallet.referral_balance, 0);
  if v_before < v_award.amount then
    raise exception 'Referral balance is no longer available for this payout. Transfer or another payout may have used it.';
  end if;
  v_after := v_before - v_award.amount;
  v_paid_ref := nullif(trim(coalesce(p_paid_reference, '')), '');
  v_tx_ref := 'REF-PAID-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  update public.wallets
     set referral_balance = v_after,
         paid_referral_rewards = coalesce(paid_referral_rewards, 0) + v_award.amount,
         updated_at = now()
   where id = v_award.agent_id;

  update public.agent_referral_awards
     set status = 'paid', paid_reference = v_paid_ref, paid_note = nullif(trim(coalesce(p_note, '')), ''),
         paid_at = now(), paid_by = p_admin_id, updated_at = now()
   where id = p_award_id;

  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, meta)
  values
    (v_award.agent_id, v_tx_ref, 'debit', 'Referral reward paid by admin', v_award.amount,
     coalesce(v_wallet.balance, 0), 'settled', jsonb_build_object(
       'award_id', p_award_id, 'audit_reference', v_award.audit_reference,
       'paid_reference', v_paid_ref, 'referral_balance_before', v_before,
       'referral_balance_after', v_after, 'admin_id', p_admin_id));

  insert into public.transactions
    (agent_id, reference, amount, type, description, balance_before, balance_after, status, metadata, created_at, updated_at)
  values
    (v_award.agent_id, v_tx_ref, v_award.amount, 'Referral Reward Payout',
     'Referral reward marked paid by admin', coalesce(v_wallet.balance, 0),
     coalesce(v_wallet.balance, 0), 'success', jsonb_build_object(
       'award_id', p_award_id, 'audit_reference', v_award.audit_reference,
       'paid_reference', v_paid_ref, 'admin_id', p_admin_id), now(), now());

  return jsonb_build_object('success', true, 'status', 'paid', 'awardId', p_award_id,
    'auditReference', v_award.audit_reference, 'amount', v_award.amount,
    'paidReference', v_paid_ref, 'referralBalance', v_after);
end;
$$;

revoke all on function public.admin_award_agent_referral(uuid, numeric, text, text, uuid) from public, anon, authenticated;
revoke all on function public.transfer_referral_rewards(uuid, numeric) from public, anon;
revoke all on function public.admin_mark_agent_referral_paid(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_award_agent_referral(uuid, numeric, text, text, uuid) to service_role;
grant execute on function public.transfer_referral_rewards(uuid, numeric) to authenticated, service_role;
grant execute on function public.admin_mark_agent_referral_paid(uuid, text, text, uuid) to service_role;
