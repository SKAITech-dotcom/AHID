-- Add the separate ECG Postpaid product while keeping existing prepaid rows
-- stored as bill_type = 'ecg'.
alter table public.utility_orders
  drop constraint if exists utility_orders_bill_type_check;

alter table public.utility_orders
  add constraint utility_orders_bill_type_check
  check (bill_type in ('ecg', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes'));
