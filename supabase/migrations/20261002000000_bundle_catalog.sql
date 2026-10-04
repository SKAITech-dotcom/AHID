-- The bundle catalog the storefront actually sells, keyed so the client can
-- send a bundle_id and the server can resolve the price itself.
--
-- Why a table at all, when the sale prices live in _shared/dataCatalog.ts:
--   - the storefront needs to render a list per network with a price and a
--     title without hardcoding a fourth copy of the catalog in the browser;
--   - validity/tier ("30 days", "Kokoo", midnight) has no source of truth yet,
--     so the columns exist and stay NULL rather than being invented. The UI
--     renders validity only when it is set.
--
-- Availability is owned by the provider, not by this table: sync-data-bundle-catalog
-- reads the live provider catalog and deactivates anything the provider cannot
-- currently deliver or has capped. A row is only sellable while active is true.
create table if not exists public.bundle_catalog (
  bundle_id text primary key,
  network text not null check (network in ('mtn', 'telecel', 'airteltigo')),
  title text not null,
  -- NULL means "we do not know", which is different from a real "no expiry".
  validity text,
  volume_mb integer not null check (volume_mb > 0),
  price numeric(12,2) not null check (price > 0),
  -- Which provider package fulfills this bundle, so checkout can prove the
  -- bundle is deliverable instead of trusting the client's volume.
  provider_package_id text,
  provider_cost numeric(12,2),
  active boolean not null default true,
  -- Why a bundle stopped being sellable, for diagnosing the storefront.
  inactive_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bundle_catalog_active_idx
  on public.bundle_catalog (network, sort_order)
  where active;

alter table public.bundle_catalog enable row level security;

-- The storefront is public and has to render the catalog before anyone signs
-- in, so active rows are world-readable. Inactive rows are not exposed, which
-- keeps capped or undeliverable bundles out of the API entirely rather than
-- relying on the client to hide them.
drop policy if exists "Public can read active data bundles" on public.bundle_catalog;
create policy "Public can read active data bundles"
  on public.bundle_catalog
  for select
  to anon, authenticated
  using (active);

-- Only the service-role catalog sync writes here.
revoke insert, update, delete on public.bundle_catalog from anon, authenticated;

-- Kept in step with the activity-log trigger list on the order tables.
drop trigger if exists bundle_catalog_touch_updated_at on public.bundle_catalog;
create or replace function public.touch_bundle_catalog_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger bundle_catalog_touch_updated_at
  before update on public.bundle_catalog
  for each row execute function public.touch_bundle_catalog_updated_at();