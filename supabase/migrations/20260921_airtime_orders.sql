-- ============================================================================
-- Migration: Airtime Orders & Automated Top-Up System
-- Created: 2026-09-21
-- ============================================================================

-- 1. Create airtime_orders table
create table if not exists public.airtime_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  payment_reference text not null unique,
  recipient_phone text not null,
  network text not null check (network in ('mtn', 'telecel', 'at')),
  amount numeric(10, 2) not null check (amount >= 1.00 and amount <= 500.00),
  fee_amount numeric(10, 2) not null default 0.00,
  gross_amount numeric(10, 2) not null,
  payment_method text not null default 'paystack' check (payment_method in ('paystack', 'wallet')),
  payment_status text not null default 'pending_payment' check (payment_status in ('pending_payment', 'paid', 'failed')),
  airtime_status text not null default 'pending' check (airtime_status in ('pending', 'processing', 'delivered', 'failed', 'pending_provider')),
  provider_reference text,
  provider_response jsonb,
  failure_reason text,
  customer_name text,
  customer_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for performance & rapid lookups
create index if not exists idx_airtime_orders_ref on public.airtime_orders(payment_reference);
create index if not exists idx_airtime_orders_user on public.airtime_orders(user_id);
create index if not exists idx_airtime_orders_agent on public.airtime_orders(agent_id);
create index if not exists idx_airtime_orders_phone on public.airtime_orders(recipient_phone);
create index if not exists idx_airtime_orders_created on public.airtime_orders(created_at desc);

-- Enable RLS
alter table public.airtime_orders enable row level security;

-- Policies:
-- 1. Anyone can query an order by its unique payment reference (post-payment confirmation receipt)
create policy "Allow reference lookup for airtime orders"
  on public.airtime_orders
  for select
  using (true);

-- 2. Authenticated users can insert orders (or anonymous via edge functions)
create policy "Allow insert airtime orders"
  on public.airtime_orders
  for insert
  with check (true);

-- 3. Authenticated agents/users can view their own orders
create policy "Users can view own airtime orders"
  on public.airtime_orders
  for select
  using (auth.uid() = user_id or auth.uid() = agent_id);


-- 2. Stored Procedure: fulfil_airtime_order
-- Safely marks an order as paid, sets delivery status, and logs provider data
create or replace function public.fulfil_airtime_order(
  p_order_id uuid,
  p_airtime_status text default 'delivered',
  p_provider_reference text default null,
  p_provider_response jsonb default null,
  p_failure_reason text default null
)
returns public.airtime_orders
language plpgsql
security definer
as $$
declare
  v_order public.airtime_orders;
begin
  select * into v_order
  from public.airtime_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Airtime order not found with ID %', p_order_id;
  end if;

  -- Idempotency: if already delivered, do not repeat
  if v_order.airtime_status = 'delivered' then
    return v_order;
  end if;

  update public.airtime_orders
  set
    payment_status = 'paid',
    airtime_status = p_airtime_status,
    provider_reference = coalesce(p_provider_reference, v_order.provider_reference),
    provider_response = coalesce(p_provider_response, v_order.provider_response),
    failure_reason = p_failure_reason,
    updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;


-- 3. Stored Procedure: purchase_agent_airtime
-- Atomically deducts from agent wallet and creates airtime order
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
  -- Check and lock wallet balance
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

  -- Deduct amount from wallet
  update public.wallets
  set
    balance = balance - p_amount,
    updated_at = now()
  where id = p_agent_id;

  -- Insert order record marked as paid
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

  return v_order;
end;
$$;
