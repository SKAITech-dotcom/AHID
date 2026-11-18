-- Durable QR scan analytics for public agent stores and the main platform QR.

create table if not exists public.qr_scans (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references auth.users(id) on delete set null,
  scan_type text not null check (scan_type in ('agent_store', 'admin_system')),
  store_slug text,
  scanned_at timestamptz not null default now(),
  user_agent text
);

create index if not exists qr_scans_type_time_idx
  on public.qr_scans(scan_type, scanned_at desc);
create index if not exists qr_scans_agent_time_idx
  on public.qr_scans(agent_id, scanned_at desc)
  where agent_id is not null;

alter table public.qr_scans enable row level security;
revoke all on public.qr_scans from anon, authenticated;
grant insert on public.qr_scans to anon, authenticated;
grant select on public.qr_scans to authenticated;

create or replace function public.can_read_qr_scan_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agents
    where id = auth.uid()
      and role in ('admin', 'super_admin')
      and status = 'active'
      and is_active = true
  );
$$;

create or replace function public.can_record_agent_qr_scan(p_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.agents where id = p_agent_id);
$$;

drop policy if exists "Public can record valid QR scans" on public.qr_scans;
create policy "Public can record valid QR scans"
  on public.qr_scans for insert
  to anon, authenticated
  with check (
    (scan_type = 'admin_system' and agent_id is null)
    or (
      scan_type = 'agent_store'
      and agent_id is not null
      and public.can_record_agent_qr_scan(agent_id)
    )
  );

drop policy if exists "Agents can read their QR scans" on public.qr_scans;
create policy "Agents can read their QR scans"
  on public.qr_scans for select
  to authenticated
  using (auth.uid() = agent_id);

drop policy if exists "Admins can read all QR scans" on public.qr_scans;
create policy "Admins can read all QR scans"
  on public.qr_scans for select
  to authenticated
  using (public.can_read_qr_scan_admin());

revoke all on function public.can_read_qr_scan_admin() from public, anon, authenticated;
grant execute on function public.can_read_qr_scan_admin() to authenticated, service_role;
revoke all on function public.can_record_agent_qr_scan(uuid) from public, anon, authenticated;
grant execute on function public.can_record_agent_qr_scan(uuid) to anon, authenticated, service_role;
