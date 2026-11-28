-- Admin-only display overrides for order recovery/reconciliation.
-- These columns never replace the real provider status or wallet/payment state.
-- Provider polling continues to update provider_status/provider_state, while
-- the override lets an operator explain a resend/recovery to customers and
-- agents until the live provider result is settled.

alter table public.agent_data_orders
  add column if not exists admin_status text,
  add column if not exists admin_status_note text,
  add column if not exists admin_status_updated_at timestamptz,
  add column if not exists admin_status_updated_by uuid references auth.users(id) on delete set null;

alter table public.public_data_orders
  add column if not exists admin_status text,
  add column if not exists admin_status_note text,
  add column if not exists admin_status_updated_at timestamptz,
  add column if not exists admin_status_updated_by uuid references auth.users(id) on delete set null;

alter table public.store_orders
  add column if not exists admin_status text,
  add column if not exists admin_status_note text,
  add column if not exists admin_status_updated_at timestamptz,
  add column if not exists admin_status_updated_by uuid references auth.users(id) on delete set null;

alter table public.orders
  add column if not exists admin_status text,
  add column if not exists admin_status_note text,
  add column if not exists admin_status_updated_at timestamptz,
  add column if not exists admin_status_updated_by uuid references auth.users(id) on delete set null;

create index if not exists agent_data_orders_admin_status_idx
  on public.agent_data_orders (admin_status, created_at desc)
  where admin_status is not null;

create index if not exists public_data_orders_admin_status_idx
  on public.public_data_orders (admin_status, created_at desc)
  where admin_status is not null;

create index if not exists store_orders_admin_status_idx
  on public.store_orders (admin_status, created_at desc)
  where admin_status is not null;

comment on column public.agent_data_orders.admin_status is
  'Optional admin display status. Does not alter provider or wallet settlement status.';
comment on column public.public_data_orders.admin_status is
  'Optional admin display status. Does not alter payment verification or provider settlement.';
comment on column public.store_orders.admin_status is
  'Optional admin display status. Does not alter payment verification or provider settlement.';
