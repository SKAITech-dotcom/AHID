-- Unify Store & Pricing and Wallet commission withdrawals.
-- A request reserves commission; the admin's paid action performs the actual
-- deduction exactly once and records the manual disbursement reference.

alter table public.agent_payouts
  add column if not exists commission_debited boolean not null default false,
  add column if not exists commission_debited_at timestamptz,
  add column if not exists disbursement_reference text;

-- The legacy withdraw_commission RPC deducted commission when the request was
-- created and used status=pending. Preserve those historical deductions so the
-- new paid-settlement function does not deduct them a second time.
update public.agent_payouts p
set commission_debited = true,
    commission_debited_at = coalesce(p.paid_at, p.requested_at)
where p.status = 'pending'
  and p.commission_debited = false;

create or replace function public.settle_agent_commission_payout(
  p_payout_id uuid,
  p_admin_id uuid default auth.uid(),
  p_disbursement_reference text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.agent_payouts%rowtype;
  v_wallet public.wallets%rowtype;
  v_agent_code text;
  v_ref text;
  v_payment_ref text;
  v_before numeric;
  v_after numeric;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Administrator access required.';
  end if;

  select * into v_payout
  from public.agent_payouts
  where id = p_payout_id
  for update;
  if not found then raise exception 'Payout request not found: %', p_payout_id; end if;
  if v_payout.status = 'paid' then raise exception 'This payout request has already been paid.'; end if;
  if v_payout.status in ('rejected', 'failed') then raise exception 'This payout request is already finalized as %.', v_payout.status; end if;

  v_ref := coalesce(nullif(trim(v_payout.reference), ''), 'PAYOUT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));
  v_payment_ref := nullif(trim(coalesce(p_disbursement_reference, '')), '');
  select agent_code into v_agent_code from public.agents where id = v_payout.agent_id;

  if not v_payout.commission_debited then
    select * into v_wallet from public.wallets where id = v_payout.agent_id for update;
    if not found then raise exception 'Agent wallet not found.'; end if;
    if coalesce(v_wallet.commission_balance, 0) < v_payout.amount then
      raise exception 'Insufficient commission balance. Available: GHS %', coalesce(v_wallet.commission_balance, 0);
    end if;
    v_before := coalesce(v_wallet.commission_balance, 0);
    v_after := v_before - v_payout.amount;
    update public.wallets
       set commission_balance = v_after,
           withdrawn_commission = coalesce(withdrawn_commission, 0) + v_payout.amount,
           updated_at = now()
     where id = v_payout.agent_id;

    insert into public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, status, meta)
    values
      (v_payout.agent_id, v_ref, 'debit', 'Manual store commission payout', v_payout.amount,
       coalesce(v_wallet.balance, 0), 'settled',
       jsonb_build_object('commission_before', v_before, 'commission_after', v_after,
         'payout_id', p_payout_id, 'admin_id', p_admin_id,
         'disbursement_reference', v_payment_ref));

    update public.agent_payouts
       set commission_debited = true,
           commission_debited_at = now()
     where id = p_payout_id;
  end if;

  update public.agent_payouts
     set status = 'paid',
         reference = v_ref,
         disbursement_reference = coalesce(v_payment_ref, disbursement_reference),
         admin_note = coalesce(v_payment_ref, admin_note),
         paid_at = now(),
         reviewed_at = now(),
         reviewed_by = p_admin_id,
         updated_at = now()
   where id = p_payout_id;

  if exists (select 1 from public.transactions where reference = v_ref) then
    update public.transactions
       set status = 'success',
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'payout_id', p_payout_id, 'paid_at', now(), 'admin_id', p_admin_id,
             'disbursement_reference', v_payment_ref),
           updated_at = now()
     where reference = v_ref;
  else
    insert into public.transactions
      (agent_id, agent_code, reference, amount, type, description, status, metadata, created_at, updated_at)
    values
      (v_payout.agent_id, v_agent_code, v_ref, v_payout.amount, 'Commission Withdrawal',
       'Manual store commission payout', 'success',
       jsonb_build_object('payout_id', p_payout_id, 'admin_id', p_admin_id,
         'disbursement_reference', v_payment_ref), now(), now());
  end if;

  perform public.log_activity(
    'Manual store commission payout of GHS ' || v_payout.amount || ' for agent ' || coalesce(v_agent_code, v_payout.agent_id::text),
    jsonb_build_object('payout_id', p_payout_id, 'agent_id', v_payout.agent_id,
      'amount', v_payout.amount, 'payout_reference', v_ref,
      'disbursement_reference', v_payment_ref), p_admin_id);

  return jsonb_build_object('success', true, 'status', 'paid', 'reference', v_ref,
    'disbursementReference', v_payment_ref, 'amount', v_payout.amount,
    'commissionDebited', true);
end;
$$;

revoke all on function public.settle_agent_commission_payout(uuid, uuid, text) from public, anon;
grant execute on function public.settle_agent_commission_payout(uuid, uuid, text) to service_role;

create or replace function public.admin_decide_payout(
  p_payout_id uuid,
  p_decision text,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.agent_payouts%rowtype;
  v_wallet public.wallets%rowtype;
  v_new_status text;
  v_ref text;
begin
  if not public.is_admin() then raise exception 'Unauthorized: Administrator access required.'; end if;
  select * into v_payout from public.agent_payouts where id = p_payout_id for update;
  if not found then raise exception 'Payout request not found: %', p_payout_id; end if;
  if v_payout.status in ('paid', 'rejected', 'failed') then
    raise exception 'This payout request has already been finalized as %', v_payout.status;
  end if;

  if lower(trim(p_decision)) = 'paid' then
    return public.settle_agent_commission_payout(p_payout_id, auth.uid(), p_note);
  elsif lower(trim(p_decision)) in ('rejected', 'failed') then
    if v_payout.commission_debited then
      select * into v_wallet from public.wallets where id = v_payout.agent_id for update;
      if not found then raise exception 'Agent wallet not found.'; end if;
      update public.wallets
         set commission_balance = coalesce(commission_balance, 0) + v_payout.amount,
             withdrawn_commission = greatest(0, coalesce(withdrawn_commission, 0) - v_payout.amount),
             updated_at = now()
       where id = v_payout.agent_id;
    end if;
    v_ref := coalesce(nullif(trim(v_payout.reference), ''), 'PAYOUT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));
    update public.agent_payouts
       set status = 'rejected', reference = v_ref,
           commission_debited = false, commission_debited_at = null,
           admin_note = coalesce(nullif(trim(p_note), ''), 'Rejected by admin'),
           reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
     where id = p_payout_id;
    update public.transactions
       set status = 'failed', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('rejected_at', now(), 'rejection_reason', p_note), updated_at = now()
     where reference = v_ref;
    v_new_status := 'rejected';
  elsif lower(trim(p_decision)) = 'processing' then
    update public.agent_payouts
       set status = 'processing', admin_note = coalesce(nullif(trim(p_note), ''), admin_note), reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
     where id = p_payout_id;
    v_new_status := 'processing';
  else
    raise exception 'Invalid payout decision. Use paid, processing, or rejected.';
  end if;
  return jsonb_build_object('success', true, 'payout_id', p_payout_id, 'status', v_new_status);
end;
$$;

revoke all on function public.admin_decide_payout(uuid, text, text) from public, anon;
grant execute on function public.admin_decide_payout(uuid, text, text) to authenticated, service_role;
