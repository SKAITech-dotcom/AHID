-- ---------------------------------------------------------------------------
-- Data order status tracking
--
-- Data bundles are fulfilled asynchronously: the provider accepting a request
-- is NOT the same as the bundle reaching the handset. Until now both data
-- order tables allowed only 'processing' | 'successful' | 'failed' and the
-- agent path flipped straight to 'successful' on acceptance, so the dashboard
-- reported "Successful" for orders the provider had not even started.
--
-- This migration:
--   1. Widens both data order status checks to the full order lifecycle so
--      Pending / Processing / Completed / Failed / Cancelled are all storable.
--   2. Adds provider tracking columns to agent_data_orders so an accepted
--      order can be reconciled against the provider later.
--   3. Splits "provider accepted" (record_agent_data_dispatch) from "provider
--      settled the order" (settle_agent_data_order), with the settle function
--      refunding the agent's wallet exactly once on failure/cancellation.
-- ---------------------------------------------------------------------------

-- 1a. Agent data orders: full lifecycle status set.
alter table public.agent_data_orders
  drop constraint if exists agent_data_orders_status_check;

alter table public.agent_data_orders
  add constraint agent_data_orders_status_check
  check (status in ('pending', 'processing', 'successful', 'failed', 'cancelled'));

-- 1b. Public data orders: allow an explicit cancellation as well.
alter table public.public_data_orders
  drop constraint if exists public_data_orders_status_check;

alter table public.public_data_orders
  add constraint public_data_orders_status_check
  check (status in ('pending_payment', 'processing', 'successful', 'failed', 'cancelled'));

-- 2. Provider tracking columns for agent data orders. The existing
--    provider_reference column holds our own internal reference (DATA-<uuid>),
--    so the provider's own order id needs its own column.
alter table public.agent_data_orders
  add column if not exists provider_name text;
alter table public.agent_data_orders
  add column if not exists provider_order_id text;

create index if not exists agent_data_orders_pending_sync_idx
  on public.agent_data_orders (agent_id, created_at desc)
  where status in ('pending', 'processing');

-- Backfill provider tracking from the payloads already stored on disk.
update public.agent_data_orders
set provider_name = 'grandtech'
where provider_response is not null
  and provider_name is null
  and provider_response ? 'orderId';

update public.agent_data_orders
set provider_order_id = provider_response ->> 'orderId'
where provider_response is not null
  and provider_order_id is null
  and provider_response ? 'orderId';

-- ---------------------------------------------------------------------------
-- 3. record_agent_data_dispatch
--
-- Called the moment the provider accepts the order. Records who the provider
-- is and which order id to poll later, but deliberately LEAVES the order in
-- 'processing' -- acceptance is not delivery.
-- ---------------------------------------------------------------------------
create or replace function public.record_agent_data_dispatch(
  p_order_id uuid,
  p_provider text,
  p_provider_order_id text,
  p_provider_response jsonb
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.agent_data_orders
  set provider_name = coalesce(p_provider, provider_name),
      provider_order_id = coalesce(p_provider_order_id, provider_order_id),
      provider_response = coalesce(p_provider_response, provider_response),
      status = case when status = 'pending' then 'processing' else status end
  where id = p_order_id
    and status in ('pending', 'processing');
end;
$$;

revoke all on function public.record_agent_data_dispatch(uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. settle_agent_data_order
--
-- The only path that moves a data order to a terminal state. Idempotent: it
-- only acts while the order is still open, and refunds through
-- refund_agent_wallet, which is itself idempotent per debit reference. A
-- concurrent or repeated poll can therefore never double-refund.
-- ---------------------------------------------------------------------------
create or replace function public.settle_agent_data_order(
  p_order_id uuid,
  p_status text,
  p_provider_response jsonb default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_order public.agent_data_orders%rowtype;
  v_status text;
begin
  if p_status not in ('successful', 'failed', 'cancelled') then
    raise exception 'Unsupported terminal data order status: %', p_status;
  end if;

  select * into v_order
  from public.agent_data_orders
  where id = p_order_id
  for update;

  if not found then
    return 'missing';
  end if;

  -- Already terminal (or mid-flight non-terminal update): nothing to do.
  if v_order.status not in ('pending', 'processing') then
    return v_order.status;
  end if;

  if p_status in ('failed', 'cancelled') then
    perform public.refund_agent_wallet(
      v_order.agent_id,
      v_order.provider_reference,
      v_order.amount,
      'Data bundle ' || p_status || ' (' || v_order.provider_reference || ')'
    );
  end if;

  update public.agent_data_orders
  set status = p_status,
      provider_response = coalesce(p_provider_response, provider_response),
      completed_at = now()
  where id = p_order_id
  returning status into v_status;

  return v_status;
end;
$$;

revoke all on function public.settle_agent_data_order(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. mark_public_data_order
--
-- Updated so a public data order can also settle as 'cancelled', and so a
-- status that is not terminal does not stamp completed_at.
-- ---------------------------------------------------------------------------
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
      provider_response = coalesce(p_provider_response, provider_response),
      completed_at = case when p_status in ('successful', 'failed', 'cancelled') then now() else completed_at end
  where id = p_order_id
    and status in ('pending_payment', 'processing');
end;
$$;

revoke all on function public.mark_public_data_order(uuid, text, numeric, text, jsonb) from public, anon, authenticated;
