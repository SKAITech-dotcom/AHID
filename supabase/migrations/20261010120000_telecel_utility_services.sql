-- Add Telecel Broadband and Telecel Postpaid Bill utility services. Both are
-- routed through the Hubtel-backed utility provider and stored in utility_orders.

alter table public.utility_orders
  drop constraint if exists utility_orders_bill_type_check;

alter table public.utility_orders
  add constraint utility_orders_bill_type_check
  check (bill_type in ('ecg', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes', 'telecel_broadband', 'telecel_postpaid'));

alter table public.utility_orders
  drop constraint if exists utility_orders_bill_category_check;

alter table public.utility_orders
  add constraint utility_orders_bill_category_check
  check (bill_category in ('electricity', 'water', 'tv', 'broadband', 'postpaid'));

create index if not exists utility_orders_bill_type_idx
  on public.utility_orders(bill_type, created_at desc);