-- ============================================================================
-- Migration: Agent-only Airtime & Transaction History Support
-- Created: 2026-09-22
-- Adds idempotency protection to airtime_orders (prevents duplicate purchases
-- caused by repeated clicks / repeated API requests).
-- RLS intentionally left unchanged.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'airtime_orders'
  ) then
    alter table public.airtime_orders add column if not exists idempotency_key text;
    execute 'create unique index if not exists airtime_orders_idempotency_key_idx on public.airtime_orders (idempotency_key) where idempotency_key is not null';
  end if;
end $$;