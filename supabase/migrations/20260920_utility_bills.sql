-- Migration: Utility Bill Orders and Agent Custom Pricing Schema
-- Supports ECG Prepaid Electricity, Ghana Water (GWCL), TV Subscriptions (DStv, GOtv, StarTimes)

-- 1. Utility Orders Table
create table if not exists public.utility_orders (
  id uuid primary key default gen_random_uuid(),
  bill_type text not null check (bill_type in ('ecg', 'ghana_water', 'dstv', 'gotv', 'startimes')),
  bill_category text not null check (bill_category in ('electricity', 'water', 'tv')),
  account_number text not null,
  meter_type text,
  package_name text,
  amount numeric(12,2) not null check (amount > 0),
  fee_amount numeric(12,2) not null default 0 check (fee_amount >= 0),
  gross_amount numeric(12,2) not null check (gross_amount > 0),
  customer_name text,
  customer_phone text not null,
  customer_email text not null,
  payment_reference text not null unique,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'processing', 'completed', 'failed')),
  token_code text,
  provider_reference text,
  provider_response jsonb,
  agent_id uuid references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  completed_at timestamptz
);

create index if not exists utility_orders_payment_reference_idx
  on public.utility_orders(payment_reference);

create index if not exists utility_orders_email_created_idx
  on public.utility_orders(customer_email, created_at desc);

create index if not exists utility_orders_account_idx
  on public.utility_orders(account_number);

create index if not exists utility_orders_agent_idx
  on public.utility_orders(agent_id, created_at desc);

alter table public.utility_orders enable row level security;

-- Authenticated agents can view orders they placed
create policy "Agents can view their own utility orders"
  on public.utility_orders
  for select
  using (auth.uid() = agent_id);

-- Admins can view all utility orders
create policy "Admins can view all utility orders"
  on public.utility_orders
  for select
  using (
    exists (
      select 1 from public.agents
      where public.agents.id = auth.uid()
        and public.agents.role = 'admin'
    )
  );

-- Helper function to generate formatted 20-digit prepaid electricity token
create or replace function public.generate_ecg_token()
returns text
language plpgsql
as $$
declare
  digits text := '';
  i integer;
begin
  for i in 1..20 loop
    digits := digits || floor(random() * 10)::text;
  end loop;
  return substr(digits, 1, 4) || '-' ||
         substr(digits, 5, 4) || '-' ||
         substr(digits, 9, 4) || '-' ||
         substr(digits, 13, 4) || '-' ||
         substr(digits, 17, 4);
end;
$$;

-- Atomic fulfillment function for utility orders invoked by webhook or backend verification
create or replace function public.fulfil_utility_order(
  p_order_id uuid,
  p_token_code text default null,
  p_provider_data jsonb default null
)
returns public.utility_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.utility_orders%rowtype;
  v_generated_token text;
begin
  select * into v_order from public.utility_orders where id = p_order_id for update;
  if not found then
    raise exception 'Utility order not found: %', p_order_id;
  end if;

  if v_order.status in ('paid', 'completed') then
    return v_order;
  end if;

  if p_token_code is not null and trim(p_token_code) <> '' then
    v_generated_token := trim(p_token_code);
  elsif v_order.bill_category = 'electricity' then
    v_generated_token := public.generate_ecg_token();
  else
    v_generated_token := 'RCPT-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  end if;

  update public.utility_orders
  set status = 'completed',
      token_code = v_generated_token,
      paid_at = coalesce(paid_at, now()),
      completed_at = now(),
      provider_response = coalesce(p_provider_data, provider_response)
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

revoke all on function public.fulfil_utility_order(uuid, text, jsonb) from public, anon, authenticated;

-- 2. Agent Custom Pricing Table
create table if not exists public.agent_pricing (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  pricing_key text not null,
  price numeric(12,2) not null check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, pricing_key)
);

create index if not exists agent_pricing_agent_idx on public.agent_pricing(agent_id);

alter table public.agent_pricing enable row level security;

create policy "Agents can view their own custom pricing"
  on public.agent_pricing
  for select
  using (auth.uid() = agent_id);

create policy "Agents can insert their own custom pricing"
  on public.agent_pricing
  for insert
  with check (auth.uid() = agent_id);

create policy "Agents can update their own custom pricing"
  on public.agent_pricing
  for update
  using (auth.uid() = agent_id);

create policy "Agents can delete their own custom pricing"
  on public.agent_pricing
  for delete
  using (auth.uid() = agent_id);
