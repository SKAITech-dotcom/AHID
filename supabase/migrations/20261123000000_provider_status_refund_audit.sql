-- Durable provider reconciliation and refund audit.
--
-- Provider acceptance is not delivery. The provider order id and our internal
-- order id must remain linked so repeated status polls can never issue a second
-- wallet credit.

alter table public.agent_wallet_refunds
  add column if not exists order_type text,
  add column if not exists order_id uuid,
  add column if not exists internal_reference text,
  add column if not exists provider text,
  add column if not exists provider_order_id text,
  add column if not exists provider_reference text;

create unique index if not exists agent_wallet_refunds_order_idx
  on public.agent_wallet_refunds(order_type, order_id)
  where order_id is not null;

create index if not exists agent_wallet_refunds_provider_order_idx
  on public.agent_wallet_refunds(provider, provider_order_id)
  where provider_order_id is not null;

-- This function records the refund after refund_agent_wallet has atomically
-- credited the wallet. It also annotates the credit ledger row, so both the
-- agent wallet history and the admin history contain the same identifiers.
create or replace function public.record_agent_provider_refund(
  p_order_type text,
  p_order_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_internal_reference text,
  p_provider text,
  p_provider_order_id text,
  p_provider_reference text,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_ref text;
  v_metadata jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'Unauthorized. Provider refunds are server-only.';
  end if;
  if nullif(trim(coalesce(p_order_type, '')), '') is null or p_order_id is null then
    raise exception 'Provider refund order identity is required.';
  end if;
  if p_agent_id is null then
    raise exception 'Provider refund agent is required.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Provider refund amount must be greater than zero.';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'source', 'provider_reconciliation',
    'order_type', trim(p_order_type),
    'order_id', p_order_id,
    'internal_reference', nullif(trim(coalesce(p_internal_reference, '')), ''),
    'provider', nullif(trim(coalesce(p_provider, '')), ''),
    'provider_order_id', nullif(trim(coalesce(p_provider_order_id, '')), ''),
    'provider_reference', nullif(trim(coalesce(p_provider_reference, '')), '')
  );

  select id into v_id
    from public.agent_wallet_refunds
   where order_type = trim(p_order_type)
     and order_id = p_order_id
   for update;

  if found then
    -- The wallet credit is already idempotent. Keep its metadata current if a
    -- later provider response supplies an identifier that was missing before.
    update public.wallet_transactions credit
       set meta = coalesce(credit.meta, '{}'::jsonb) || v_metadata
     where credit.id = (
       select credit_row.id
         from public.wallet_transactions credit_row
         join public.wallet_transactions debit_row
           on debit_row.id = credit_row.reversed_transaction_id
        where credit_row.agent_id = p_agent_id
          and credit_row.type = 'credit'
          and debit_row.type = 'debit'
          and debit_row.reference = p_internal_reference
        order by credit_row.created_at desc
        limit 1
     );
    update public.transactions refund_tx
       set metadata = coalesce(refund_tx.metadata, '{}'::jsonb) || v_metadata
     where refund_tx.id = (
       select candidate.id
         from public.transactions candidate
        where candidate.agent_id = p_agent_id
          and candidate.type = 'Wallet Refund'
          and candidate.metadata->>'debit_reference' = p_internal_reference
        order by candidate.created_at desc
        limit 1
     );
    return v_id;
  end if;

  v_ref := 'AUTO-REF-' || upper(substr(md5(trim(p_order_type) || ':' || p_order_id::text), 1, 24));
  insert into public.agent_wallet_refunds
    (agent_id, amount, reference, reason, source, metadata,
     order_type, order_id, internal_reference, provider, provider_order_id, provider_reference)
  values
    (p_agent_id, round(p_amount, 2), v_ref,
     coalesce(nullif(trim(p_reason), ''), 'Provider rejected order'),
     'provider_reconciliation', v_metadata,
     trim(p_order_type), p_order_id, nullif(trim(coalesce(p_internal_reference, '')), ''),
     nullif(trim(coalesce(p_provider, '')), ''),
     nullif(trim(coalesce(p_provider_order_id, '')), ''),
     nullif(trim(coalesce(p_provider_reference, '')), ''))
  on conflict (order_type, order_id) where order_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
      from public.agent_wallet_refunds
     where order_type = trim(p_order_type)
       and order_id = p_order_id;
  end if;

  update public.wallet_transactions credit
     set meta = coalesce(credit.meta, '{}'::jsonb) || v_metadata
   where credit.id = (
     select credit_row.id
       from public.wallet_transactions credit_row
       join public.wallet_transactions debit_row
         on debit_row.id = credit_row.reversed_transaction_id
      where credit_row.agent_id = p_agent_id
        and credit_row.type = 'credit'
        and debit_row.type = 'debit'
        and debit_row.reference = p_internal_reference
      order by credit_row.created_at desc
      limit 1
   );
  update public.transactions refund_tx
     set metadata = coalesce(refund_tx.metadata, '{}'::jsonb) || v_metadata
   where refund_tx.id = (
     select candidate.id
       from public.transactions candidate
      where candidate.agent_id = p_agent_id
        and candidate.type = 'Wallet Refund'
        and candidate.metadata->>'debit_reference' = p_internal_reference
      order by candidate.created_at desc
      limit 1
   );

  return v_id;
exception
  when unique_violation then
    select id into v_id
      from public.agent_wallet_refunds
     where order_type = trim(p_order_type)
       and order_id = p_order_id;
    return v_id;
end;
$$;

revoke all on function public.record_agent_provider_refund(text, uuid, uuid, numeric, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_agent_provider_refund(text, uuid, uuid, numeric, text, text, text, text, text, jsonb)
  to service_role;

-- The terminal settlement RPC is the only place allowed to close an agent
-- data order after provider reconciliation. Failed/cancelled orders refund and
-- audit as one database transaction.
create or replace function public.settle_agent_data_order(
  p_order_id uuid,
  p_status text,
  p_provider_response jsonb default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.agent_data_orders%rowtype;
  v_status text;
  v_response jsonb := coalesce(p_provider_response, '{}'::jsonb);
  v_provider_order_id text;
begin
  if p_status not in ('successful', 'failed', 'cancelled') then
    raise exception 'Unsupported terminal data order status: %', p_status;
  end if;

  select * into v_order
    from public.agent_data_orders
   where id = p_order_id
   for update;
  if not found then return 'missing'; end if;
  if v_order.status not in ('pending', 'processing') then return v_order.status; end if;

  v_provider_order_id := coalesce(
    nullif(v_order.provider_order_id, ''),
    nullif(v_response->>'providerOrderId', ''),
    nullif(v_response->>'orderId', ''),
    nullif(v_response->>'providerReference', '')
  );

  if p_status in ('failed', 'cancelled') then
    perform public.refund_agent_wallet(
      v_order.agent_id,
      v_order.provider_reference,
      v_order.amount,
      'Data bundle ' || p_status || ' (' || v_order.provider_reference || ')'
    );
    perform public.record_agent_provider_refund(
      'agent_data_orders', v_order.id, v_order.agent_id, v_order.amount,
      v_order.provider_reference,
      coalesce(v_order.provider_name, v_response->>'provider'),
      v_provider_order_id,
      v_order.provider_reference,
      'Provider ' || p_status || ' for data bundle',
      v_response
    );
  end if;

  update public.agent_data_orders
     set status = p_status,
         provider_order_id = coalesce(provider_order_id, v_provider_order_id),
         provider_status = coalesce(nullif(v_response->>'lastProviderStatus', ''), provider_status),
         provider_state = coalesce(nullif(v_response->>'lastProviderState', ''), p_status),
         last_status_checked_at = now(),
         provider_response = coalesce(p_provider_response, provider_response),
         completed_at = now()
   where id = p_order_id
   returning status into v_status;
  return v_status;
end;
$$;

revoke all on function public.settle_agent_data_order(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.settle_agent_data_order(uuid, text, jsonb) to service_role;

-- Immediate provider rejection uses this legacy RPC, so it receives the same
-- auditable, idempotent refund treatment as a later status poll.
create or replace function public.complete_agent_data_order(
  p_order_id uuid,
  p_success boolean,
  p_provider_response jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.agent_data_orders%rowtype;
  v_response jsonb := coalesce(p_provider_response, '{}'::jsonb);
  v_provider_order_id text;
begin
  select * into v_order from public.agent_data_orders where id = p_order_id for update;
  if not found or v_order.status <> 'processing' then return; end if;

  v_provider_order_id := coalesce(
    nullif(v_order.provider_order_id, ''),
    nullif(v_response->>'providerOrderId', ''),
    nullif(v_response->>'orderId', ''),
    nullif(v_response->>'providerReference', '')
  );

  if p_success then
    update public.agent_data_orders
       set status = 'processing',
           provider_order_id = coalesce(provider_order_id, v_provider_order_id),
           provider_response = v_response,
           provider_status = coalesce(nullif(v_response->>'lastProviderStatus', ''), 'PROCESSING'),
           provider_state = 'processing',
           last_status_checked_at = now(),
           completed_at = null
     where id = p_order_id;
  else
    perform public.refund_agent_wallet(
      v_order.agent_id, v_order.provider_reference, round(v_order.amount, 2),
      'Refund for failed data order ' || v_order.provider_reference
    );
    perform public.record_agent_provider_refund(
      'agent_data_orders', v_order.id, v_order.agent_id, v_order.amount,
      v_order.provider_reference,
      coalesce(v_order.provider_name, v_response->>'provider'),
      v_provider_order_id,
      v_order.provider_reference,
      'Provider rejected data order',
      v_response
    );
    update public.agent_data_orders
       set status = 'failed',
           provider_order_id = coalesce(provider_order_id, v_provider_order_id),
           provider_response = v_response,
           provider_status = coalesce(nullif(v_response->>'lastProviderStatus', ''), 'FAILED'),
           provider_state = 'failed',
           last_status_checked_at = now(),
           completed_at = now()
     where id = p_order_id;
  end if;
end;
$$;

revoke all on function public.complete_agent_data_order(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.complete_agent_data_order(uuid, boolean, jsonb) to service_role;

-- Keep provider fields on public orders in sync when a status is settled by an
-- Edge Function instead of a direct table update.
create or replace function public.mark_public_data_order(
  p_order_id uuid,
  p_status text,
  p_provider_amount numeric,
  p_provider_reference text,
  p_provider_response jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_response jsonb := coalesce(p_provider_response, '{}'::jsonb);
begin
  update public.public_data_orders
     set status = p_status,
         provider_amount = coalesce(p_provider_amount, provider_amount),
         provider_reference = coalesce(p_provider_reference, provider_reference),
         provider_status = coalesce(nullif(v_response->>'lastProviderStatus', ''), provider_status),
         provider_state = coalesce(nullif(v_response->>'lastProviderState', ''), p_status),
         last_status_checked_at = now(),
         provider_response = coalesce(p_provider_response, provider_response),
         completed_at = case when p_status in ('successful', 'failed', 'cancelled') then now() else completed_at end
   where id = p_order_id
     and status in ('pending_payment', 'processing');
end;
$$;

revoke all on function public.mark_public_data_order(uuid, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_public_data_order(uuid, text, numeric, text, jsonb) to service_role;

-- Make automatic provider refunds visible in the same transactions ledger used
-- by the agent wallet page. The debit row lock and status check keep this
-- insert idempotent when several portals poll the same order together.
create or replace function public.refund_agent_wallet(
  p_agent_id uuid,
  p_debit_reference text,
  p_amount numeric,
  p_reason text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
  v_after numeric;
  v_refund numeric;
  v_debit public.wallet_transactions%rowtype;
  v_credit_reference text;
  v_agent_code text;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Refund amount must be a positive amount with at most two decimals.';
  end if;
  v_refund := round(p_amount, 2);

  select * into v_debit
    from public.wallet_transactions
   where agent_id = p_agent_id
     and reference = p_debit_reference
     and type = 'debit'
   order by created_at
   limit 1
   for update;
  if not found then
    raise exception 'No payable wallet debit found for reference %.', p_debit_reference;
  end if;
  if v_debit.status = 'refunded' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return v_balance;
  end if;
  if v_debit.amount <> v_refund then
    raise exception 'Refund amount must match the original wallet debit of GHS %.', v_debit.amount;
  end if;

  select coalesce(balance, 0) into v_balance
    from public.wallets where id = p_agent_id for update;
  if not found then raise exception 'Agent wallet not found.'; end if;
  v_after := v_balance + v_refund;
  v_credit_reference := v_debit.reference || '-REF-' || substr(md5(random()::text), 1, 6);
  select agent_code into v_agent_code from public.agents where id = p_agent_id;

  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;
  insert into public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id, meta)
  values
    (p_agent_id, v_credit_reference, 'credit', coalesce(p_reason, 'Refund for ' || v_debit.reference),
     v_refund, v_after, 'settled', v_debit.id,
     jsonb_build_object('source', 'provider_reconciliation', 'debit_reference', v_debit.reference));

  insert into public.transactions
    (agent_id, agent_code, reference, amount, type, balance_before, balance_after,
     description, status, metadata, created_at)
  values
    (p_agent_id, v_agent_code, v_credit_reference, v_refund, 'Wallet Refund',
     v_balance, v_after, coalesce(p_reason, 'Refund for ' || v_debit.reference),
     'success', jsonb_build_object(
       'source', 'provider_reconciliation',
       'debit_reference', v_debit.reference,
       'reversed_transaction_id', v_debit.id
     ), now());

  update public.wallet_transactions
     set status = 'refunded', updated_at = now()
   where id = v_debit.id;
  return v_after;
exception
  when unique_violation then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return v_balance;
end;
$$;

revoke all on function public.refund_agent_wallet(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.refund_agent_wallet(uuid, text, numeric, text) to service_role;
