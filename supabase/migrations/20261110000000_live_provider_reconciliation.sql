-- Keep provider identity and the last live answer as durable columns. The JSON
-- response remains available for audit, but reconciliation must not infer an
-- order from an unrelated paginated response.

alter table public.agent_data_orders
  add column if not exists provider_status text,
  add column if not exists provider_state text,
  add column if not exists last_status_checked_at timestamptz;

alter table public.public_data_orders
  add column if not exists provider_status text,
  add column if not exists provider_state text,
  add column if not exists last_status_checked_at timestamptz;

alter table public.store_orders
  add column if not exists provider_status text,
  add column if not exists provider_state text,
  add column if not exists last_status_checked_at timestamptz;

alter table public.afa_registrations
  add column if not exists provider_status text,
  add column if not exists provider_updated_at timestamptz;

-- Backfill only identifiers that are explicitly present in the persisted
-- purchase response. Never use the first row from a provider order list.
update public.agent_data_orders
   set provider_order_id = coalesce(
     nullif(provider_order_id, ''),
     nullif(provider_response->>'orderId', ''),
     nullif(provider_response->>'order_id', ''),
     nullif(provider_response->'payload'->>'orderId', ''),
     nullif(provider_response->'payload'->>'order_id', ''),
     nullif(provider_response->'data'->>'orderId', '')
   )
 where provider_order_id is null
   and provider_response is not null;

update public.agent_data_orders
   set provider_status = nullif(provider_response->>'lastProviderStatus', ''),
       provider_state = nullif(provider_response->>'lastProviderState', ''),
       last_status_checked_at = case
         when nullif(provider_response->>'checkedAt', '') is not null
         then (provider_response->>'checkedAt')::timestamptz
         else last_status_checked_at
       end
 where provider_response is not null;

update public.public_data_orders
   set provider_status = nullif(provider_response->>'lastProviderStatus', ''),
       provider_state = nullif(provider_response->>'lastProviderState', ''),
       last_status_checked_at = case
         when nullif(provider_response->>'lastStatusCheckedAt', '') is not null
         then (provider_response->>'lastStatusCheckedAt')::timestamptz
         else last_status_checked_at
       end
 where provider_response is not null;

update public.store_orders
   set provider_status = nullif(provider_response->>'lastProviderStatus', ''),
       provider_state = nullif(provider_response->>'lastProviderState', ''),
       last_status_checked_at = case
         when nullif(provider_response->>'checkedAt', '') is not null
         then (provider_response->>'checkedAt')::timestamptz
         else last_status_checked_at
       end
 where provider_response is not null;

update public.afa_registrations
   set provider_status = coalesce(
     nullif(provider_status, ''),
     nullif(provider_response->>'lastProviderStatus', ''),
     nullif(provider_response->'webhook'->>'status', '')
   )
 where provider_response is not null;

create index if not exists agent_data_orders_provider_reconcile_idx
  on public.agent_data_orders(provider_name, status, created_at desc);
create index if not exists public_data_orders_provider_reconcile_idx
  on public.public_data_orders(provider_name, status, created_at desc);
create index if not exists store_orders_provider_reconcile_idx
  on public.store_orders(provider, fulfilment_status, created_at desc);
create index if not exists afa_registrations_provider_reference_idx
  on public.afa_registrations(provider_reference);
