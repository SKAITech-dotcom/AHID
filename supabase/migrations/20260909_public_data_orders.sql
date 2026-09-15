-- Payment-backed public data orders. The provider cost is paid from the company agent wallet.
create table if not exists public.public_data_orders (
  id uuid primary key default gen_random_uuid(),
  payment_reference text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  network_type text not null check (network_type in ('mtn', 'telecel', 'airteltigo')),
  volume_mb integer not null check (volume_mb > 0),
  sale_amount numeric(12,2) not null check (sale_amount > 0),
  provider_amount numeric(12,2),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'processing', 'successful', 'failed')),
  provider_reference text unique,
  provider_response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists public_data_orders_email_created_idx
  on public.public_data_orders(customer_email, created_at desc);

alter table public.public_data_orders enable row level security;

-- Public orders are retrieved only through the reference + email Edge Function.

create or replace function public.mark_public_data_order(
  p_order_id uuid,
  p_status text,
  p_provider_amount numeric,
  p_provider_reference text,
  p_provider_response jsonb
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.public_data_orders
  set status = p_status,
      provider_amount = coalesce(p_provider_amount, provider_amount),
      provider_reference = coalesce(p_provider_reference, provider_reference),
      provider_response = p_provider_response,
      completed_at = case when p_status in ('successful', 'failed') then now() else completed_at end
  where id = p_order_id and status in ('pending_payment', 'processing');
end;
$$;

revoke all on function public.mark_public_data_order(uuid, text, numeric, text, jsonb) from public, anon, authenticated;