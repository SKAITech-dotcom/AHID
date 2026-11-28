-- Central operational controls for services and Standard Data provider routing.
-- Public clients may read availability only; all writes stay behind the
-- authenticated admin-portal-api Edge Function.

create table if not exists public.system_service_controls (
  service_key text primary key check (service_key in (
    'afa_registration',
    'results_checker',
    'utility_bills',
    'airtime_top_up'
  )),
  label text not null,
  available boolean not null default true,
  unavailable_reason text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.system_service_controls (service_key, label, available)
values
  ('afa_registration', 'AFA Registration', true),
  ('results_checker', 'WASSCE / NOV/DEC Results Checker', true),
  ('utility_bills', 'Utility Bills', true),
  ('airtime_top_up', 'Airtime Top-Up', true)
on conflict (service_key) do update set
  label = excluded.label;

create table if not exists public.data_bundle_provider_routes (
  bundle_id text primary key references public.bundle_catalog(bundle_id) on delete cascade,
  provider text not null check (provider in ('swift', 'grandtech')),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Preserve the existing safe routing as the initial system-wide choice. Admins
-- can change any row later without changing the sale price or package id.
insert into public.data_bundle_provider_routes (bundle_id, provider)
select
  bundle_id,
  case
    when network = 'mtn' and volume_mb = 1024 then 'grandtech'
    when network = 'telecel' and volume_mb = 5120 then 'grandtech'
    else 'swift'
  end
from public.bundle_catalog
on conflict (bundle_id) do nothing;

-- Restore the main Standard Data tiers that were intentionally taken out of
-- stock. The catalog remains the source of truth for all other rows and admin
-- controls can disable any individual tier again.
update public.bundle_catalog
set active = true,
    inactive_reason = null,
    updated_at = now()
where volume_mb >= 1024
  and (network = 'mtn' or bundle_id = 'telecel-5gb');

alter table public.system_service_controls enable row level security;
alter table public.data_bundle_provider_routes enable row level security;

drop policy if exists "Public can read system service availability" on public.system_service_controls;
create policy "Public can read system service availability"
  on public.system_service_controls for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.system_service_controls from anon, authenticated;
revoke all on public.data_bundle_provider_routes from anon, authenticated;
grant select on public.system_service_controls to anon, authenticated, service_role;
grant all on public.system_service_controls to service_role;
grant all on public.data_bundle_provider_routes to service_role;

create or replace function public.touch_system_control_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists system_service_controls_touch_updated_at on public.system_service_controls;
create trigger system_service_controls_touch_updated_at
before update on public.system_service_controls
for each row execute function public.touch_system_control_updated_at();
drop trigger if exists data_bundle_provider_routes_touch_updated_at on public.data_bundle_provider_routes;
create trigger data_bundle_provider_routes_touch_updated_at
before update on public.data_bundle_provider_routes
for each row execute function public.touch_system_control_updated_at();
