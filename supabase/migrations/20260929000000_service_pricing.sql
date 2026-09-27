-- ============================================================================
-- Global service pricing (single source of truth for what agents are charged)
--
-- Why: prices used to live only in the AFA_FEE_AMOUNT edge-function secret, so
-- the price could not be shown on the page and changing it was awkward. The
-- price is now a row agents can read, and changing it is a single UPDATE:
--
--   update public.service_pricing set price = 15.00 where service = 'afa';
--
-- Only the server may change prices: there are no client INSERT/UPDATE/DELETE
-- policies, so a browser can read a price but never alter one.
-- ============================================================================

create table if not exists public.service_pricing (
  service text primary key,
  price numeric(12,2) not null check (price >= 0),
  label text,
  updated_at timestamptz not null default now()
);

alter table public.service_pricing enable row level security;

-- Signed-in agents may read prices so the UI can display them.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'service_pricing'
      and policyname = 'Signed in users can view service pricing'
  ) then
    create policy "Signed in users can view service pricing"
      on public.service_pricing for select
      to authenticated
      using (true);
  end if;
end $$;

-- Seed the AFA price. Existing rows are left alone so this is safe to re-run.
insert into public.service_pricing (service, price, label)
values ('afa', 12.00, 'AFA Registration Fee')
on conflict (service) do nothing;
