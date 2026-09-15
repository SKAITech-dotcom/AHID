-- Server-authoritative agent data bundle orders and wallet reservations.
create table if not exists public.agent_data_orders (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  provider_reference text not null unique,
  network_type text not null check (network_type in ('mtn', 'telecel', 'airteltigo')),
  phone text not null,
  volume_mb integer not null check (volume_mb > 0),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'processing' check (status in ('processing', 'successful', 'failed')),
  provider_response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agent_data_orders_agent_created_idx
  on public.agent_data_orders(agent_id, created_at desc);

alter table public.agent_data_orders enable row level security;
create policy "Agents can view their own data orders"
  on public.agent_data_orders for select using (auth.uid() = agent_id);

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
  v_order_id uuid;
begin
  select balance into v_balance from public.wallets where id = p_agent_id for update;
  if coalesce(v_balance, 0) < p_amount then
    raise exception 'Insufficient wallet balance';
  end if;

  update public.wallets set balance = balance - p_amount where id = p_agent_id;
  insert into public.agent_data_orders
    (agent_id, provider_reference, network_type, phone, volume_mb, amount)
  values
    (p_agent_id, p_reference, p_network_type, p_phone, p_volume_mb, p_amount)
  returning id into v_order_id;
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
begin
  select * into v_order from public.agent_data_orders where id = p_order_id for update;
  if not found or v_order.status <> 'processing' then return; end if;

  if p_success then
    update public.agent_data_orders
      set status = 'successful', provider_response = p_provider_response, completed_at = now()
      where id = p_order_id;
  else
    update public.wallets set balance = balance + v_order.amount where id = v_order.agent_id;
    update public.agent_data_orders
      set status = 'failed', provider_response = p_provider_response, completed_at = now()
      where id = p_order_id;
  end if;
end;
$$;

revoke all on function public.reserve_agent_data_order(uuid, text, text, text, integer, numeric) from public, anon, authenticated;
revoke all on function public.complete_agent_data_order(uuid, boolean, jsonb) from public, anon, authenticated;
