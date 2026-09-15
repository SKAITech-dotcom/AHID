-- Base agent identity + wallet schema required by the app and the data-order edge function.
create table if not exists public.agents (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  agent_code text unique,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  agent_code text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallets (
  id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agents enable row level security;
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;

create policy "Agents can read their own profile" on public.profiles for select using (auth.uid() = id);
create policy "Agents can update their own profile" on public.profiles for update using (auth.uid() = id);
create policy "Agents can insert their own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Agents can read their own wallet" on public.wallets for select using (auth.uid() = id);
create policy "Agents can update their own wallet" on public.wallets for update using (auth.uid() = id);
create policy "Agents can insert their own wallet" on public.wallets for insert with check (auth.uid() = id);
create policy "Agents can read their own agent row" on public.agents for select using (auth.uid() = id);
create policy "Agents can update their own agent row" on public.agents for update using (auth.uid() = id);
create policy "Agents can insert their own agent row" on public.agents for insert with check (auth.uid() = id);

-- Payment-backed wallet funding. Browser code must never credit a balance directly.
create table if not exists public.wallet_topups (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  payment_reference text not null unique,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'failed')),
  provider text not null default 'paystack',
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists wallet_topups_agent_created_idx on public.wallet_topups(agent_id, created_at desc);
alter table public.wallet_topups enable row level security;
create policy "Agents can view their own wallet topups" on public.wallet_topups for select using (auth.uid() = agent_id);

create or replace function public.fulfil_wallet_topup(p_topup_id uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_topup public.wallet_topups%rowtype; v_balance numeric;
begin
  select * into v_topup from public.wallet_topups where id = p_topup_id for update;
  if not found then raise exception 'Wallet top-up not found'; end if;
  if v_topup.status = 'paid' then
    select balance into v_balance from public.wallets where id = v_topup.agent_id;
    return coalesce(v_balance, 0);
  end if;
  insert into public.wallets (id, balance) values (v_topup.agent_id, v_topup.amount)
  on conflict (id) do update set balance = public.wallets.balance + excluded.balance, updated_at = now() returning balance into v_balance;
  update public.wallet_topups set status = 'paid', paid_at = now() where id = v_topup.id;
  return v_balance;
end;
$$;
revoke all on function public.fulfil_wallet_topup(uuid) from public, anon, authenticated;
