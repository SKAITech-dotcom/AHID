-- The older wallet migration was marked applied remotely without creating the
-- table. Repair that prerequisite and add a uniquely-versioned cashout schema.
create table if not exists public.wallets (
  id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallets enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wallets' and policyname = 'Agents can read their own wallet') then
    create policy "Agents can read their own wallet" on public.wallets for select using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wallets' and policyname = 'Agents can update their own wallet') then
    create policy "Agents can update their own wallet" on public.wallets for update using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wallets' and policyname = 'Agents can insert their own wallet') then
    create policy "Agents can insert their own wallet" on public.wallets for insert with check (auth.uid() = id);
  end if;
end $$;

create table if not exists public.cashout_deposit_requests (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 50),
  payer_phone text not null check (payer_phone ~ '^0[0-9]{9}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  settlement_reference text,
  admin_note text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);

create unique index if not exists cashout_deposit_one_pending_request_per_agent
  on public.cashout_deposit_requests(agent_id) where status = 'pending';
create unique index if not exists cashout_deposit_settlement_reference_unique
  on public.cashout_deposit_requests(settlement_reference) where settlement_reference is not null;
create index if not exists cashout_deposit_requests_status_requested_idx
  on public.cashout_deposit_requests(status, requested_at);

alter table public.cashout_deposit_requests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cashout_deposit_requests' and policyname = 'Agents can view their own cashout deposit requests') then
    create policy "Agents can view their own cashout deposit requests" on public.cashout_deposit_requests for select using (auth.uid() = agent_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cashout_deposit_requests' and policyname = 'Agents can create their own cashout deposit requests') then
    create policy "Agents can create their own cashout deposit requests" on public.cashout_deposit_requests for insert with check (auth.uid() = agent_id);
  end if;
end $$;

create or replace function public.review_cashout_deposit_request(
  p_request_id uuid,
  p_approved boolean,
  p_settlement_reference text default null,
  p_admin_note text default null,
  p_admin_id uuid default null
)
returns public.cashout_deposit_requests
language plpgsql security definer set search_path = public as $$
declare
  v_request public.cashout_deposit_requests%rowtype;
begin
  select * into v_request from public.cashout_deposit_requests where id = p_request_id for update;
  if not found then raise exception 'Cashout deposit request not found'; end if;
  if v_request.status <> 'pending' then raise exception 'This cashout deposit request has already been reviewed'; end if;
  if p_approved and nullif(trim(coalesce(p_settlement_reference, '')), '') is null then
    raise exception 'A verified MoMo settlement reference is required before approval';
  end if;
  if p_approved then
    insert into public.wallets (id, balance) values (v_request.agent_id, v_request.amount)
    on conflict (id) do update set balance = public.wallets.balance + excluded.balance, updated_at = now();
  end if;
  update public.cashout_deposit_requests
    set status = case when p_approved then 'approved' else 'rejected' end,
        settlement_reference = nullif(trim(coalesce(p_settlement_reference, '')), ''),
        admin_note = nullif(trim(coalesce(p_admin_note, '')), ''),
        reviewed_at = now(), reviewed_by = p_admin_id
    where id = v_request.id returning * into v_request;
  return v_request;
end;
$$;

revoke all on function public.review_cashout_deposit_request(uuid, boolean, text, text, uuid)
  from public, anon, authenticated;
