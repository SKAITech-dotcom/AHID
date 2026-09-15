-- Results-checker order and stock tables are created first so a fresh Supabase project
-- does not fail on missing `agents` or `results_orders` references.
create table if not exists public.agents (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  agent_code text unique,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.results_orders (
  id uuid primary key default gen_random_uuid(),
  exam_type text not null check (exam_type in ('BECE', 'WASSCE', 'NOV/DEC')),
  quantity integer not null check (quantity > 0),
  amount numeric(12,2) not null check (amount > 0),
  recipient_phone text not null,
  email text not null,
  payment_reference text not null unique,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'failed')),
  serial_pin text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.agents add column if not exists role text not null default 'agent'
  check (role in ('agent', 'admin'));

create table if not exists public.result_checker_pins (
  id uuid primary key default gen_random_uuid(),
  exam_type text not null check (exam_type in ('BECE', 'WASSCE', 'NOV/DEC')),
  pin text not null,
  serial text,
  status text not null default 'available' check (status in ('available', 'sold')),
  result_order_id uuid references public.results_orders(id),
  created_at timestamptz not null default now(),
  sold_at timestamptz,
  unique (exam_type, pin)
);

create unique index if not exists results_orders_payment_reference_key
  on public.results_orders(payment_reference)
  where payment_reference is not null;
create index if not exists result_checker_pins_available_idx
  on public.result_checker_pins(exam_type, status);

alter table public.result_checker_pins enable row level security;
-- No browser policies: PINs are accessed only by Edge Functions using the service-role key.

-- Atomically assigns stock after Paystack confirms a payment. It prevents two payments
-- from receiving the same PIN when their webhooks arrive at the same time.
create or replace function public.fulfil_result_checker_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.results_orders%rowtype;
  v_pins jsonb;
  v_count integer;
begin
  select * into v_order from public.results_orders where id = p_order_id for update;
  if not found then raise exception 'Result order not found'; end if;
  if v_order.status = 'paid' then
    return coalesce(v_order.serial_pin::jsonb, '[]'::jsonb);
  end if;

  with selected as (
    select id, pin, serial
    from public.result_checker_pins
    where exam_type = v_order.exam_type and status = 'available'
    order by created_at
    for update skip locked
    limit v_order.quantity
  ), updated as (
    update public.result_checker_pins p
    set status = 'sold', result_order_id = v_order.id, sold_at = now()
    from selected s
    where p.id = s.id
    returning s.pin, s.serial
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('pin', pin, 'serial', serial)), '[]'::jsonb)
  into v_count, v_pins
  from updated;

  if v_count <> v_order.quantity then
    raise exception 'Insufficient PIN stock for %', v_order.exam_type;
  end if;

  update public.results_orders
  set status = 'paid', serial_pin = v_pins::text, paid_at = now()
  where id = v_order.id;
  return v_pins;
end;
$$;

revoke all on function public.fulfil_result_checker_order(uuid) from public, anon, authenticated;
