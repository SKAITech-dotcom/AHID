-- Public agent-store checkouts use Skaipay (Hubtel) for bundles below GHS 10
-- and Paystack for bundles priced at GHS 10 or more. Keep the selected
-- provider and provider-neutral amounts on the durable order row.

alter table public.store_orders
  add column if not exists payment_provider text not null default 'paystack',
  add column if not exists payment_fee_amount numeric(12,2) not null default 0,
  add column if not exists payment_gross_amount numeric(12,2);

update public.store_orders
set payment_provider = coalesce(nullif(lower(payment_provider), ''), 'paystack'),
    payment_fee_amount = coalesce(payment_fee_amount, payment_fee, 0),
    payment_gross_amount = coalesce(payment_gross_amount, sale_amount + coalesce(payment_fee, 0))
where payment_provider is null
   or payment_fee_amount is null
   or payment_gross_amount is null;

alter table public.store_orders
  drop constraint if exists store_orders_payment_provider_check;

alter table public.store_orders
  add constraint store_orders_payment_provider_check
  check (payment_provider in ('paystack', 'hubtel'));

create index if not exists store_orders_payment_provider_idx
  on public.store_orders (payment_provider, created_at desc);
