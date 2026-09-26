-- ---------------------------------------------------------------------------
-- Fix: successful Paystack wallet top-ups were marked 'paid' but never credited
-- the wallet, so every agent balance stayed at 0.00 and each purchase failed
-- with "Insufficient wallet balance".
--
-- 1. Rewrite public.fulfil_wallet_topup so it credits the wallet AND writes a
--    wallet_transactions ledger row (idempotent via the unique reference).
-- 2. Reconcile every already-'paid' top-up that never received its credit.
-- ---------------------------------------------------------------------------

create or replace function public.fulfil_wallet_topup(p_topup_id uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_topup public.wallet_topups%rowtype;
  v_balance numeric;
begin
  select * into v_topup from public.wallet_topups where id = p_topup_id for update;
  if not found then raise exception 'Wallet top-up not found'; end if;

  if v_topup.status = 'paid' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = v_topup.agent_id;
    return v_balance;
  end if;

  insert into public.wallets (id, balance) values (v_topup.agent_id, v_topup.amount)
  on conflict (id) do update
    set balance = public.wallets.balance + excluded.balance, updated_at = now()
  returning balance into v_balance;

  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, meta)
  values (
    v_topup.agent_id,
    v_topup.payment_reference,
    'credit',
    'Wallet top-up via Paystack',
    v_topup.amount,
    v_balance,
    jsonb_build_object('payment_type', 'wallet_topup', 'provider', 'paystack', 'topup_id', v_topup.id)
  )
  on conflict (reference) do nothing;

  update public.wallet_topups set status = 'paid', paid_at = now() where id = v_topup.id;
  return v_balance;
end;
$$;

revoke all on function public.fulfil_wallet_topup(uuid) from public, anon, authenticated;

-- Reconcile top-ups that were already flagged paid but never funded.
do $$
declare
  v_topup record;
  v_balance numeric;
begin
  for v_topup in
    select t.id, t.agent_id, t.amount, t.payment_reference
      from public.wallet_topups t
     where t.status = 'paid'
       and not exists (
         select 1 from public.wallet_transactions w where w.reference = t.payment_reference
       )
     order by t.paid_at
  loop
    insert into public.wallets (id, balance) values (v_topup.agent_id, v_topup.amount)
    on conflict (id) do update
      set balance = public.wallets.balance + excluded.balance, updated_at = now()
    returning balance into v_balance;

    insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, meta)
    values (
      v_topup.agent_id,
      v_topup.payment_reference,
      'credit',
      'Wallet top-up via Paystack (reconciled)',
      v_topup.amount,
      v_balance,
      jsonb_build_object('payment_type', 'wallet_topup', 'provider', 'paystack', 'reconciled', true)
    )
    on conflict (reference) do nothing;
  end loop;
end $$;
