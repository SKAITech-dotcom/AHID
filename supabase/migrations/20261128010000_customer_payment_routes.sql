-- System-wide customer payment gateway routing for Standard Data bundles.
-- This controls only guest/non-agent and public agent-store checkout. Agent
-- purchases remain wallet-funded and never use a customer payment gateway.

create table if not exists public.customer_payment_routes (
  bundle_id text primary key references public.bundle_catalog(bundle_id) on delete cascade,
  provider text not null check (provider in ('skaipay', 'paystack')),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep the existing customer checkout policy as the initial route. Admins can
-- select either gateway for any bundle from System Control afterward.
insert into public.customer_payment_routes (bundle_id, provider)
select bundle_id,
  case when price >= 10 and price <= 50 then 'paystack' else 'skaipay' end
from public.bundle_catalog
on conflict (bundle_id) do nothing;

alter table public.customer_payment_routes enable row level security;
revoke all on public.customer_payment_routes from anon, authenticated;
grant all on public.customer_payment_routes to service_role;

drop trigger if exists customer_payment_routes_touch_updated_at on public.customer_payment_routes;
create trigger customer_payment_routes_touch_updated_at
before update on public.customer_payment_routes
for each row execute function public.touch_system_control_updated_at();
