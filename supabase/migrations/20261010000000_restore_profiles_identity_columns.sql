-- ============================================================================
-- Restore legacy identity columns on profiles, server-maintained
-- ============================================================================
-- The Hubtel data-platform migration (20261006000000) created `profiles` from a
-- shape that only carries id/email/wallet_balance. Older frontends and the
-- sign-in flow still read `full_name`, `phone` and `agent_code` on profiles, so
-- those columns must exist again.
--
-- Writes are NOT reopened to browsers for a reason: profiles.wallet_balance is
-- a read-only mirror of wallets.balance and must never be client-writable (that
-- would create a second spendable balance). Instead, identity is mirrored from
-- the `agents` table - the source of truth the frontend already writes - by a
-- SECURITY DEFINER trigger, so name/code/phone stay current without granting
-- clients any write on profiles.
--
-- The `agents` table differs across environments (some deployments lost the
-- `phone` column), so the backfill and the trigger probe `agents.phone` via
-- to_regcolumn before touching it, keeping this migration valid on every shape.
-- ============================================================================

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists phone text,
  add column if not exists agent_code text;

create unique index if not exists profiles_agent_code_idx
  on public.profiles (agent_code)
  where agent_code is not null;

-- Backfill identity from the authority (agents) for accounts that existed
-- before these columns were restored. Copies phone only when the column exists.
do $$
declare
  v_has_phone boolean;
begin
  select exists(
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agents' and column_name = 'phone'
  ) into v_has_phone;

  if v_has_phone then
    update public.profiles p
    set full_name = a.full_name,
        phone = a.phone,
        agent_code = a.agent_code,
        updated_at = now()
    from public.agents a
    where a.id = p.id
      and (p.full_name is null or p.phone is null or p.agent_code is null);
  else
    update public.profiles p
    set full_name = a.full_name,
        agent_code = a.agent_code,
        updated_at = now()
    from public.agents a
    where a.id = p.id
      and (p.full_name is null or p.agent_code is null);
  end if;
end;
$$;

create or replace function public.sync_profile_identity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_has_phone boolean;
begin
  select exists(
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agents' and column_name = 'phone'
  ) into v_has_phone;

  insert into public.profiles (id, full_name, phone, agent_code)
  values (
    new.id,
    new.full_name,
    case when v_has_phone then new.phone else null end,
    new.agent_code
  )
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.profiles.full_name),
        phone = case when v_has_phone
                     then coalesce(excluded.phone, public.profiles.phone)
                     else public.profiles.phone end,
        agent_code = coalesce(excluded.agent_code, public.profiles.agent_code),
        updated_at = now();
  return new;
end;
$$;

revoke all on function public.sync_profile_identity() from public, anon, authenticated;

drop trigger if exists agents_sync_profile_identity on public.agents;
create trigger agents_sync_profile_identity
  after insert or update on public.agents
  for each row execute function public.sync_profile_identity();