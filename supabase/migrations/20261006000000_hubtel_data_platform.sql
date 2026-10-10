-- ============================================================================
-- Instant data vending platform: networks, profiles, bundles, data_transactions
-- ============================================================================
--
-- This is the schema for the SwiftVendux-style instant data page (data.html):
-- pick a network, pick a bundle, enter a recipient number, pay from the agent
-- wallet, and the provider delivers.
--
-- Two things this migration deliberately does NOT do, because doing them would
-- have reintroduced bugs this project has already paid for:
--
-- 1. It does not create a third wallet balance. There are already two
--    `wallet_balance`-shaped columns in this database (agents.wallet_balance,
--    legacy, and wallets.balance, current). wallets.balance is the only
--    authoritative one: it is what charge_agent_wallet / refund_agent_wallet
--    lock and update, and what wallet_transactions can rebuild it from.
--    profiles.wallet_balance below is a *mirror* of wallets.balance, written
--    only by a trigger. If it were ever writable, two balances could disagree
--    and the same money could be spent twice. Reads are allowed, writes are
--    not, for the same reason wallets has no client UPDATE policy.
--
-- 2. It does not create a `transactions` table. One already exists (empty,
--    legacy shape: agent_code/reference/type). It is left alone; the rows this
--    platform writes go to data_transactions, which has the provider, bundle
--    and recipient columns the purchase flow actually needs.
--
-- Availability is owned by the provider, not by this table. Every seeded bundle
-- ships with is_available = false, because no Hubtel package id has been
-- mapped yet and this project has a hard rule: the storefront must not be able
-- to sell something that cannot be delivered. Turning a bundle on is one
-- UPDATE once hubtel_package_id is filled in - see HUBTEL_DATA_SETUP.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. networks
-- ---------------------------------------------------------------------------
-- `id` is the short key the UI and the API use ('at', 'mtn', 'telecel').
-- `legacy_key` maps back to the older, longer key the pre-existing catalog and
-- frontends still use ('airteltigo'), so the two systems can be compared
-- without translating names in every query.
--
-- phone_prefixes is data rather than code on purpose. Ghanaian operator
-- allocations get revised, and a corrected range should be a single UPDATE
-- rather than a code change plus a redeploy. An unknown prefix auto-detects to
-- nothing, which leaves the network as whatever the operator picked - it never
-- silently picks a wrong network.
create table if not exists public.networks (
  id text primary key,
  name text not null,
  brand_color text not null default '#2563eb',
  -- Short glyph shown in the network badge on the header card.
  badge_text text not null default 'AT',
  -- Marketing line under the network name on the header card.
  tagline text not null default 'From wallet - Instant delivery',
  legacy_key text,
  hubtel_network text,
  -- Ghanaian mobile prefixes owned by this operator, as 3-digit strings.
  phone_prefixes text[] not null default '{}',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint networks_brand_color_hex check (brand_color ~ '^#[0-9A-Fa-f]{6}$')
);

create index if not exists networks_active_idx
  on public.networks (sort_order)
  where is_active;

comment on table public.networks is
  'Mobile networks Skaitech can sell data for. Read-only to clients; the service role writes.';

-- ---------------------------------------------------------------------------
-- 2. profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  -- Mirror of wallets.balance. Never write this from a client: see the header
  -- note in this migration and sync_profile_wallet_balance below.
  wallet_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_wallet_balance_non_negative check (wallet_balance >= 0)
);

comment on column public.profiles.wallet_balance is
  'Read-only mirror of wallets.balance. Authoritative balance lives in wallets; use that for anything that spends money.';

create index if not exists profiles_email_idx on public.profiles (email);

-- Keep the mirror honest: every wallet movement refreshes it. The auth.users
-- guard matters - if a wallet row ever existed without a matching auth user,
-- the profiles foreign key would reject the insert and take the wallet update
-- down with it. A wallet balance must never be blocked by a display column.
create or replace function public.sync_profile_wallet_balance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from auth.users where id = new.id) then
    return new;
  end if;

  insert into public.profiles (id, wallet_balance)
  values (new.id, coalesce(new.balance, 0))
  on conflict (id) do update
    set wallet_balance = excluded.wallet_balance,
        updated_at = now();

  return new;
end;
$$;

revoke all on function public.sync_profile_wallet_balance() from public, anon, authenticated;

drop trigger if exists wallets_sync_profile_balance on public.wallets;
create trigger wallets_sync_profile_balance
  after insert or update of balance on public.wallets
  for each row execute function public.sync_profile_wallet_balance();

-- Idempotent provisioning, so a profile exists for every account rather than
-- only for accounts that happened to sign in before this migration ran. Called
-- by the data edge functions; SECURITY DEFINER because auth.users is not
-- readable by authenticated.
create or replace function public.ensure_profile(p_user_id uuid)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_balance numeric;
begin
  if p_user_id is null then
    raise exception 'A user id is required.';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Cannot provision a profile for an unknown user.';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  select coalesce(balance, 0) into v_balance from public.wallets where id = p_user_id;

  insert into public.profiles (id, email, wallet_balance)
  values (p_user_id, v_email, coalesce(v_balance, 0))
  on conflict (id) do update
    set email = coalesce(excluded.email, public.profiles.email),
        updated_at = now();

  return (select p from public.profiles p where p.id = p_user_id);
end;
$$;

revoke all on function public.ensure_profile(uuid) from public, anon, authenticated;
grant execute on function public.ensure_profile(uuid) to service_role;

-- Backfill for accounts that already exist. Reads wallets rather than summing
-- wallet_transactions on purpose: wallets.balance is what the RPCs maintain, so
-- mirroring it cannot disagree with what will actually be charged.
insert into public.profiles (id, email, wallet_balance)
select u.id, u.email, coalesce(w.balance, 0)
from auth.users u
left join public.wallets w on w.id = u.id
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. bundles
-- ---------------------------------------------------------------------------
-- bundle_key is what the client sends at checkout, so the price is resolved
-- server-side from this row and never taken from the request body. uuid id is
-- kept for the relational reference from data_transactions.
--
-- The spec columns are id / network_id / title / data_amount / price /
-- category / is_available. The rest exist because fulfilment needs them:
-- volume_mb is the machine-readable size the order path is denominated in,
-- hubtel_package_id is the provider's own bundle identifier, and
-- is_available + unavailable_reason are how a bundle leaves the storefront
-- without being deleted out from under an order that already references it.
create table if not exists public.bundles (
  id uuid primary key default gen_random_uuid(),
  bundle_key text not null unique,
  network_id text not null references public.networks(id) on delete restrict,
  title text not null,
  -- Human-facing size or allowance, e.g. '51MB', '1GB', '30 days - 39.93GB'.
  data_amount text not null,
  -- Machine-readable size in MB. The order path is denominated in MB, and a
  -- display string is not something to parse.
  volume_mb integer not null check (volume_mb > 0),
  price numeric(12,2) not null check (price > 0),
  category text not null default 'Standard',
  validity text,
  provider text not null default 'hubtel',
  -- The provider's identifier for this bundle. NULL means not yet mapped, and
  -- an unmapped bundle stays is_available = false.
  hubtel_package_id text,
  -- What the provider charges us, in GHS. For margin reporting only.
  provider_cost numeric(12,2),
  is_available boolean not null default false,
  unavailable_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bundles_network_available_idx
  on public.bundles (network_id, sort_order)
  where is_available;

create index if not exists bundles_volume_idx
  on public.bundles (network_id, volume_mb);

comment on table public.bundles is
  'The sellable data catalog. Availability is decided by whether a provider package is mapped, never by the client.';

-- ---------------------------------------------------------------------------
-- 4. data_transactions
-- ---------------------------------------------------------------------------
create table if not exists public.data_transactions (
  id uuid primary key default gen_random_uuid(),
  -- Human-facing order reference, also the wallet ledger debit reference.
  reference text not null unique,
  short_code text,
  user_id uuid not null references public.profiles(id) on delete cascade,
  network_id text not null references public.networks(id) on delete restrict,
  bundle_id uuid references public.bundles(id) on delete set null,
  bundle_key text,
  recipient_phone text not null,
  amount numeric(12,2) not null check (amount > 0),
  -- pending: wallet debited, provider not yet settled.
  -- success : provider confirmed delivery.
  -- failed  : provider refused, or delivery never confirmed. Wallet refunded.
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  -- Provider response, whitelisted to safe fields before it is stored. Never
  -- store the whole body: these payloads carry credentials.
  hubtel_response jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_transactions_recipient_phone_format
    check (recipient_phone ~ '^0[0-9]{9}$')
);

alter table public.data_transactions
  alter column short_code set default public.new_short_code('data_transactions');

update public.data_transactions set short_code = public.new_short_code('data_transactions')
where short_code is null;

alter table public.data_transactions alter column short_code set not null;

alter table public.data_transactions
  add constraint data_transactions_short_code_format
  check (short_code ~ '^[A-Z0-9]{5}$');

create unique index if not exists data_transactions_short_code_idx
  on public.data_transactions (short_code);

create index if not exists data_transactions_user_created_idx
  on public.data_transactions (user_id, created_at desc);

create index if not exists data_transactions_status_idx
  on public.data_transactions (status)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_data_row_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['networks', 'profiles', 'bundles', 'data_transactions'] loop
    execute format('drop trigger if exists %I_touch_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_touch_updated_at
         before update on public.%I
         for each row execute function public.touch_data_row_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------------
-- The catalog has to render before anyone signs in, so active networks and
-- available bundles are world-readable and nothing else is. Unavailable bundles
-- are excluded from the table entirely rather than being sent to the client and
-- hidden there, so an undeliverable bundle cannot be offered by a crafted
-- request either.
alter table public.networks enable row level security;
alter table public.bundles enable row level security;
alter table public.profiles enable row level security;
alter table public.data_transactions enable row level security;

drop policy if exists "Public can read active networks" on public.networks;
create policy "Public can read active networks"
  on public.networks
  for select
  to anon, authenticated
  using (is_active);

drop policy if exists "Public can read available bundles" on public.bundles;
create policy "Public can read available bundles"
  on public.bundles
  for select
  to anon, authenticated
  using (is_available);

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "Users can read their own data transactions" on public.data_transactions;
create policy "Users can read their own data transactions"
  on public.data_transactions
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies anywhere above: every write to these tables
-- goes through the service role in an edge function. Explicit revokes as well,
-- because a future policy added by mistake should not be the only thing
-- standing between a browser and a balance column.
revoke insert, update, delete on public.networks from anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.bundles from anon, authenticated;
revoke insert, update, delete on public.data_transactions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Activity log coverage
-- ---------------------------------------------------------------------------
-- The generic audit trigger from 20260930010000 installs on a table only if it
-- exists at that point, and 'profiles' did not. Attach to all four so balance
-- mirrors, catalog edits and data purchases are all in the trail.
do $$
declare
  t text;
begin
  foreach t in array array['networks', 'profiles', 'bundles', 'data_transactions'] loop
    execute format('drop trigger if exists trg_activity_log_%s on public.%I', t, t);
    execute format(
      'create trigger trg_activity_log_%s
         after insert or update or delete on public.%I
         for each row execute function public.log_row_activity()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Seed: networks
-- ---------------------------------------------------------------------------
-- Prefix lists follow the current Ghanaian operator allocations:
--   MTN         024, 025, 053, 054, 055, 059
--   AirtelTigo  026, 027, 056, 057
--   Telecel     020, 050
insert into public.networks (id, name, brand_color, badge_text, legacy_key, hubtel_network, phone_prefixes, sort_order)
values
  ('mtn',     'MTN Data',     '#FFCC00', 'MTN', 'mtn',        'MTN',        array['024','025','053','054','055','059'], 1),
  ('telecel', 'Telecel Data', '#DC2626', 'T',   'telecel',    'TELECEL',    array['020','050'], 2),
  ('at',      'AT Premium Data', '#2563EB', 'AT', 'airteltigo', 'AIRTELTIGO', array['026','027','056','057'], 3)
on conflict (id) do update
  set name = excluded.name,
      brand_color = excluded.brand_color,
      badge_text = excluded.badge_text,
      legacy_key = excluded.legacy_key,
      phone_prefixes = excluded.phone_prefixes,
      sort_order = excluded.sort_order,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- 9. Seed: bundles
-- ---------------------------------------------------------------------------
-- Prices are the SALE prices already published in _shared/dataCatalog.ts
-- (SALE_CATALOG). They are copied rather than invented: this repo has a rule
-- that a price lives in exactly one place, and if this table disagreed with
-- dataCatalog.ts the storefront could quote something it does not charge.
-- When SALE_CATALOG changes, re-run the seed with the new rows.
--
-- Every row is is_available = false. A bundle becomes sellable only when its
-- hubtel_package_id is filled in, because an order for an unmapped bundle
-- cannot be delivered - and this project has already had customers pick
-- bundles that no provider could serve.
--
-- Kokrokoo, Midnight and Voice bundles are NOT seeded. Those are named vendor
-- products whose real price and package id can only come from Hubtel's own
-- catalog; inventing a GHS figure for them would put a price on screen that we
-- have no cost basis for. HUBTEL_DATA_SETUP.md lists how to add them.
--
-- category: 'Standard' under 20GB, 'XXL' at 20GB and above.
insert into public.bundles (bundle_key, network_id, title, data_amount, volume_mb, price, category, sort_order, is_available, unavailable_reason)
values
  -- MTN
  ('mtn-5mb',    'mtn', '5MB',   '5MB',     5,     0.50,   'Standard',  10, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-10mb',   'mtn', '10MB',  '10MB',    10,    1.00,   'Standard',  20, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-20mb',   'mtn', '20MB',  '20MB',    20,    2.00,   'Standard',  30, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-30mb',   'mtn', '30MB',  '30MB',    30,    3.00,   'Standard',  40, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-50mb',   'mtn', '50MB',  '50MB',    50,    5.00,   'Standard',  50, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-100mb',  'mtn', '100MB', '100MB',   100,   10.00,  'Standard',  60, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-150mb',  'mtn', '150MB', '150MB',   150,   15.00,  'Standard',  70, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-200mb',  'mtn', '200MB', '200MB',   200,   20.00,  'Standard',  80, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-1gb',    'mtn', '1GB',   '1GB',     1024,  4.30,   'Standard',  90, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-2gb',    'mtn', '2GB',   '2GB',     2048,  8.80,   'Standard', 100, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-3gb',    'mtn', '3GB',   '3GB',     3072,  13.20,  'Standard', 110, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-4gb',    'mtn', '4GB',   '4GB',     4096,  17.60,  'Standard', 120, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-5gb',    'mtn', '5GB',   '5GB',     5120,  22.00,  'Standard', 130, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-6gb',    'mtn', '6GB',   '6GB',     6144,  26.10,  'Standard', 140, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-8gb',    'mtn', '8GB',   '8GB',     8192,  34.80,  'Standard', 150, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-10gb',   'mtn', '10GB',  '10GB',    10240, 42.00,  'Standard', 160, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-15gb',   'mtn', '15GB',  '15GB',    15360, 63.00,  'Standard', 170, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-20gb',   'mtn', '20GB',  '20GB',    20480, 84.00,  'XXL',      180, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-25gb',   'mtn', '25GB',  '25GB',    25600, 103.75, 'XXL',      190, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-30gb',   'mtn', '30GB',  '30GB',    30720, 121.50, 'XXL',      200, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-40gb',   'mtn', '40GB',  '40GB',    40960, 160.00, 'XXL',      210, false, 'Awaiting Hubtel package mapping.'),
  ('mtn-50gb',   'mtn', '50GB',  '50GB',    51200, 200.00, 'XXL',      220, false, 'Awaiting Hubtel package mapping.'),
  -- Telecel
  ('telecel-5mb',   'telecel', '5MB',   '5MB',   5,     0.50,  'Standard', 10, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-10mb',  'telecel', '10MB',  '10MB',  10,    1.00,  'Standard', 20, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-20mb',  'telecel', '20MB',  '20MB',  20,    2.00,  'Standard', 30, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-30mb',  'telecel', '30MB',  '30MB',  30,    3.00,  'Standard', 40, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-50mb',  'telecel', '50MB',  '50MB',  50,    5.00,  'Standard', 50, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-100mb', 'telecel', '100MB', '100MB', 100,   10.00, 'Standard', 60, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-150mb', 'telecel', '150MB', '150MB', 150,   15.00, 'Standard', 70, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-200mb', 'telecel', '200MB', '200MB', 200,   20.00, 'Standard', 80, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-5gb',   'telecel', '5GB',   '5GB',   5120,  21.00, 'Standard', 130, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-10gb',  'telecel', '10GB',  '10GB',  10240, 40.00, 'Standard', 160, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-15gb',  'telecel', '15GB',  '15GB',  15360, 60.00, 'Standard', 170, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-20gb',  'telecel', '20GB',  '20GB',  20480, 78.00, 'XXL',      180, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-30gb',  'telecel', '30GB',  '30GB',  30720, 114.00, 'XXL',      200, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-40gb',  'telecel', '40GB',  '40GB',  40960, 151.00, 'XXL',      210, false, 'Awaiting Hubtel package mapping.'),
  ('telecel-50gb',  'telecel', '50GB',  '50GB',  51200, 185.00, 'XXL',      220, false, 'Awaiting Hubtel package mapping.'),
  -- AirtelTigo
  ('at-5mb',    'at', '5MB',   '5MB',   5,     0.50,   'Standard',  10, false, 'Awaiting Hubtel package mapping.'),
  ('at-10mb',   'at', '10MB',  '10MB',  10,    1.00,   'Standard',  20, false, 'Awaiting Hubtel package mapping.'),
  ('at-20mb',   'at', '20MB',  '20MB',  20,    2.00,   'Standard',  30, false, 'Awaiting Hubtel package mapping.'),
  ('at-30mb',   'at', '30MB',  '30MB',  30,    3.00,   'Standard',  40, false, 'Awaiting Hubtel package mapping.'),
  ('at-50mb',   'at', '50MB',  '50MB',  50,    5.00,   'Standard',  50, false, 'Awaiting Hubtel package mapping.'),
  ('at-100mb',  'at', '100MB', '100MB', 100,   10.00,  'Standard',  60, false, 'Awaiting Hubtel package mapping.'),
  ('at-150mb',  'at', '150MB', '150MB', 150,   15.00,  'Standard',  70, false, 'Awaiting Hubtel package mapping.'),
  ('at-200mb',  'at', '200MB', '200MB', 200,   20.00,  'Standard',  80, false, 'Awaiting Hubtel package mapping.'),
  ('at-1gb',    'at', '1GB',   '1GB',   1024,  4.20,   'Standard',  90, false, 'Awaiting Hubtel package mapping.'),
  ('at-2gb',    'at', '2GB',   '2GB',   2048,  8.39,   'Standard', 100, false, 'Awaiting Hubtel package mapping.'),
  ('at-3gb',    'at', '3GB',   '3GB',   3072,  12.58,  'Standard', 110, false, 'Awaiting Hubtel package mapping.'),
  ('at-4gb',    'at', '4GB',   '4GB',   4096,  16.78,  'Standard', 120, false, 'Awaiting Hubtel package mapping.'),
  ('at-5gb',    'at', '5GB',   '5GB',   5120,  20.97,  'Standard', 130, false, 'Awaiting Hubtel package mapping.'),
  ('at-6gb',    'at', '6GB',   '6GB',   6144,  25.17,  'Standard', 140, false, 'Awaiting Hubtel package mapping.'),
  ('at-7gb',    'at', '7GB',   '7GB',   7168,  29.36,  'Standard', 150, false, 'Awaiting Hubtel package mapping.'),
  ('at-8gb',    'at', '8GB',   '8GB',   8192,  33.56,  'Standard', 160, false, 'Awaiting Hubtel package mapping.'),
  ('at-10gb',   'at', '10GB',  '10GB',  10240, 40.84,  'Standard', 170, false, 'Awaiting Hubtel package mapping.'),
  ('at-15gb',   'at', '15GB',  '15GB',  15360, 60.71,  'Standard', 180, false, 'Awaiting Hubtel package mapping.')
on conflict (bundle_key) do update
  set network_id = excluded.network_id,
      title = excluded.title,
      data_amount = excluded.data_amount,
      volume_mb = excluded.volume_mb,
      price = excluded.price,
      category = excluded.category,
      sort_order = excluded.sort_order,
      updated_at = now();
