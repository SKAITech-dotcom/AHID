-- Public/non-agent airtime checkout through Hubtel Online Checkout.
-- The existing airtime_orders table remains the source of truth for both
-- agent-wallet and guest purchases; guest rows have no agent_id and use the
-- hubtel payment method.

alter table public.airtime_orders
  add column if not exists public_access_token text;

alter table public.airtime_orders
  drop constraint if exists airtime_orders_payment_method_check;

alter table public.airtime_orders
  add constraint airtime_orders_payment_method_check
  check (payment_method in ('paystack', 'wallet', 'hubtel'));

create unique index if not exists airtime_orders_public_access_token_idx
  on public.airtime_orders(public_access_token)
  where public_access_token is not null;

create index if not exists airtime_orders_public_phone_created_idx
  on public.airtime_orders(recipient_phone, created_at desc)
  where agent_id is null;

-- Claims a paid guest order exactly once before contacting Hubtel Commission
-- Services. A row already processing/pending_provider is never dispatched a
-- second time, because an unknown provider response is not proof of failure.
create or replace function public.claim_public_airtime_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.airtime_orders;
begin
  select * into v_order
    from public.airtime_orders
   where id = p_order_id
   for update;

  if not found then return false; end if;
  if v_order.agent_id is not null then return false; end if;
  if v_order.payment_method <> 'hubtel' then return false; end if;
  if v_order.payment_status <> 'paid' then return false; end if;
  if v_order.airtime_status <> 'pending' then return false; end if;

  update public.airtime_orders
     set airtime_status = 'processing', updated_at = now()
   where id = p_order_id;
  return true;
end;
$$;

revoke all on function public.claim_public_airtime_order(uuid) from public, anon, authenticated;
grant execute on function public.claim_public_airtime_order(uuid) to service_role;
