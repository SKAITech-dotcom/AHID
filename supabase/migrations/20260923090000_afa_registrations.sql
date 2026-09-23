-- ============================================================================
-- Migration: AFA Registrations
-- Created: 2026-09-22
-- Backs the public AFA registration/tracking page and the agent AFA portal.
-- Registrations are written/read through Edge Functions using the service-role
-- key (same pattern as results_orders / utility_orders): no browser policies.
-- ============================================================================

create table if not exists public.afa_registrations (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  full_name text not null,
  phone text not null,
  town text not null,
  id_type text not null,
  id_number text not null,
  amount numeric(12,2) not null default 8.00 check (amount >= 0),
  status text not null default 'Pending'
    check (status in ('Pending', 'Processing', 'Completed', 'Cancelled')),
  source text not null default 'public'
    check (source in ('public', 'agent')),
  created_by uuid references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists afa_registrations_phone_idx
  on public.afa_registrations(phone);
create index if not exists afa_registrations_id_number_idx
  on public.afa_registrations(id_number);
create index if not exists afa_registrations_status_created_idx
  on public.afa_registrations(status, created_at desc);

alter table public.afa_registrations enable row level security;
-- No browser policies: records are accessed only by Edge Functions using the service-role key.