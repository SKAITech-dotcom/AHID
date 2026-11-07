-- Guest/non-agent Standard Data checkout now uses Hubtel Online Checkout.
-- Keep the existing Paystack columns for historical orders and add provider-
-- neutral amounts for new Hubtel payments.

alter table public.public_data_orders
  add column if not exists payment_fee_amount numeric(12,2) not null default 0,
  add column if not exists payment_gross_amount numeric(12,2);
