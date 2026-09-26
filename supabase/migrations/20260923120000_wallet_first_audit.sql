-- ============================================================================
-- Migration: Wallet-First Audit & AFA Compliance
-- Created: 2026-09-23
--
-- 1. wallet_transactions ledger + atomic charge/refund RPCs (ACID, FOR UPDATE).
--    Every service purchase (data, airtime, utility, results, AFA, public data)
--    debits once through charge_agent_wallet and, on provider failure, is
--    automatically reversed via refund_agent_wallet. No browser code ever
--    writes balances directly.
-- 2. Existing wallet RPCs (data orders + airtime) now write ledger entries so
--    the audit trail covers legacy flows too.
-- 3. afa_registrations gains date_of_birth / occupation / price_id plus
--    provider + failure tracking for the GrandTechHub AFA integration.
-- 4. results_orders / public_data_orders tie purchases to the paying agent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Wallet transaction ledger
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  type text not null check (type in ('debit', 'credit')),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2) not null,
  status text not null default 'settled' check (status in ('settled', 'refunded', 'reversed')),
  reversed_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wallet_transactions_agent_created_idx
  on public.wallet_transactions(agent_id, created_at desc);

create unique index if not exists wallet_transactions_reversal_idx
  on public.wallet_transactions(reversed_transaction_id)
  where reversed_transaction_id is not null;

alter table public.wallet_transactions enable row level security;

create policy "Agents can view their own wallet transactions"
  on public.wallet_transactions for select using (auth.uid() = agent_id);

-- ---------------------------------------------------------------------------
-- 2a. Atomic wallet charge. Locks the wallet row, validates the balance,
--     debits the wallet and writes a ledger entry in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.charge_agent_wallet(
  p_agent_id uuid,
  p_reference text,
  p_amount numeric,
  p_description text default null,
  p_meta jsonb default null
)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_after numeric;
begin
  if p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero.';
  end if;

  select balance into v_balance from public.wallets where id = p_agent_id for update;
  if not found then
    raise exception 'Agent wallet not found.';
  end if;

  if coalesce(v_balance, 0) < p_amount then
    raise exception 'Insufficient wallet balance. Available GHS %, required GHS %', v_balance, p_amount;
  end if;

  v_after := v_balance - p_amount;
  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;

  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, meta)
  values (p_agent_id, p_reference, 'debit', coalesce(p_description, 'Service purchase'), p_amount, v_after, coalesce(p_meta, '{}'::jsonb));

  return v_after;
end;
$$;

revoke all on function public.charge_agent_wallet(uuid, text, numeric, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2b. Atomic wallet refund. Reverses an earlier debit, idempotently. A debit
--     can only ever be refunded once (enforced by the reversal unique index).
-- ---------------------------------------------------------------------------
create or replace function public.refund_agent_wallet(
  p_agent_id uuid,
  p_debit_reference text,
  p_amount numeric,
  p_reason text default null
)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_after numeric;
  v_debit public.wallet_transactions%rowtype;
  v_credit_reference text;
begin
  if p_amount <= 0 then
    raise exception 'Refund amount must be greater than zero.';
  end if;

  select * into v_debit
  from public.wallet_transactions
  where agent_id = p_agent_id and reference = p_debit_reference and type = 'debit'
  order by created_at limit 1
  for update;

  if not found then
    raise exception 'No payable wallet debit found for reference %.', p_debit_reference;
  end if;

  -- Already refunded: return the current balance without charging twice.
  if v_debit.status = 'refunded' then
    select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id;
    return v_balance;
  end if;

  select coalesce(balance, 0) into v_balance from public.wallets where id = p_agent_id for update;
  v_after := v_balance + p_amount;
  v_credit_reference := v_debit.reference || '-REF-' || substr(md5(random()::text), 1, 6);

  update public.wallets set balance = v_after, updated_at = now() where id = p_agent_id;

  begin
    insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id, meta)
    values (p_agent_id, v_credit_reference, 'credit', coalesce(p_reason, 'Refund for ' || v_debit.reference), p_amount, v_after, 'settled', v_debit.id, jsonb_build_object('debit_reference', v_debit.reference));
  exception when unique_violation then
    -- A concurrent request already refunded this debit.
    return v_after;
  end;

  update public.wallet_transactions set status = 'refunded', updated_at = now() where id = v_debit.id;
  return v_after;
end;
$$;

revoke all on function public.refund_agent_wallet(uuid, text, numeric, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Existing data-order RPCs now log ledger entries.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_agent_data_order(
  p_agent_id uuid,
  p_reference text,
  p_network_type text,
  p_phone text,
  p_volume_mb integer,
  p_amount numeric
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_after numeric;
  v_order_id uuid;
begin
  select balance into v_balance from public.wallets where id = p_agent_id for update;
  if coalesce(v_balance, 0) < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;

  v_after := coalesce(v_balance, 0) - p_amount;
  update public.wallets set balance = balance - p_amount where id = p_agent_id;
  insert into public.agent_data_orders
    (agent_id, provider_reference, network_type, phone, volume_mb, amount)
  values
    (p_agent_id, p_reference, p_network_type, p_phone, p_volume_mb, p_amount)
  returning id into v_order_id;

  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after)
  values (p_agent_id, p_reference, 'debit', 'Data bundle purchase', p_amount, v_after);

  return v_order_id;
end;
$$;

create or replace function public.complete_agent_data_order(
  p_order_id uuid,
  p_success boolean,
  p_provider_response jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.agent_data_orders%rowtype;
  v_balance numeric;
  v_after numeric;
  v_debit_id uuid;
begin
  select * into v_order from public.agent_data_orders where id = p_order_id for update;
  if not found or v_order.status <> 'processing' then return; end if;

  if p_success then
    update public.agent_data_orders
      set status = 'successful', provider_response = p_provider_response, completed_at = now()
      where id = p_order_id;
  else
    select id into v_debit_id
    from public.wallet_transactions
    where agent_id = v_order.agent_id and reference = v_order.provider_reference and type = 'debit'
    order by created_at limit 1;

    select coalesce(balance, 0) into v_balance from public.wallets where id = v_order.agent_id for update;
    v_after := v_balance + v_order.amount;
    update public.wallets set balance = v_after where id = v_order.agent_id;

    insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id)
    values (v_order.agent_id, v_order.provider_reference || '-REF-' || substr(md5(random()::text), 1, 6), 'credit', 'Refund for ' || v_order.provider_reference, v_order.amount, v_after, 'settled', v_debit_id);

    if v_debit_id is not null then
      update public.wallet_transactions set status = 'refunded', updated_at = now() where id = v_debit_id;
    end if;

    update public.agent_data_orders
      set status = 'failed', provider_response = p_provider_response, completed_at = now()
      where id = p_order_id;
  end if;
end;
$$;

revoke all on function public.reserve_agent_data_order(uuid, text, text, text, integer, numeric) from public, anon, authenticated;
revoke all on function public.complete_agent_data_order(uuid, boolean, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Airtime wallet purchase logs its debit.
-- ---------------------------------------------------------------------------
create or replace function public.purchase_agent_airtime(
  p_agent_id uuid,
  p_reference text,
  p_phone text,
  p_network text,
  p_amount numeric,
  p_customer_name text default null,
  p_customer_email text default null
)
returns public.airtime_orders
language plpgsql
security definer
as $$
declare
  v_wallet_balance numeric;
  v_order public.airtime_orders;
begin
  select balance into v_wallet_balance
  from public.wallets
  where id = p_agent_id
  for update;

  if not found then
    raise exception 'Agent wallet not found.';
  end if;

  if v_wallet_balance < p_amount then
    raise exception 'Insufficient wallet balance. Balance: GHS %, Required: GHS %', v_wallet_balance, p_amount;
  end if;

  update public.wallets
  set
    balance = balance - p_amount,
    updated_at = now()
  where id = p_agent_id;

  insert into public.airtime_orders (
    user_id,
    agent_id,
    payment_reference,
    recipient_phone,
    network,
    amount,
    fee_amount,
    gross_amount,
    payment_method,
    payment_status,
    airtime_status,
    customer_name,
    customer_email
  ) values (
    p_agent_id,
    p_agent_id,
    p_reference,
    p_phone,
    p_network,
    p_amount,
    0.00,
    p_amount,
    'wallet',
    'paid',
    'pending',
    p_customer_name,
    p_customer_email
  )
  returning * into v_order;

  insert into public.wallet_transactions (agent_id, reference, type, description, amount, balance_after)
  values (p_agent_id, p_reference, 'debit', 'Airtime purchase', p_amount, v_wallet_balance - p_amount);

  return v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. AFA registrations: AFA compliance fields for GrandTechHub.
-- ---------------------------------------------------------------------------
alter table public.afa_registrations add column if not exists date_of_birth date;
alter table public.afa_registrations add column if not exists occupation text;
alter table public.afa_registrations add column if not exists price_id text;
alter table public.afa_registrations add column if not exists failure_reason text;
alter table public.afa_registrations add column if not exists provider_reference text;
alter table public.afa_registrations add column if not exists provider_response jsonb;

create index if not exists afa_registrations_created_by_idx
  on public.afa_registrations(created_by);

-- ---------------------------------------------------------------------------
-- 6. Purchases tied to the paying agent.
-- ---------------------------------------------------------------------------
alter table public.results_orders add column if not exists agent_id uuid references public.agents(id) on delete set null;
create index if not exists results_orders_agent_idx on public.results_orders(agent_id);

alter table public.public_data_orders add column if not exists agent_id uuid references public.agents(id) on delete set null;
create index if not exists public_data_orders_agent_idx on public.public_data_orders(agent_id);