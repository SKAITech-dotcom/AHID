-- ---------------------------------------------------------------------------
-- Short order codes + full activity audit trail
--
-- 1. Every order gets a short, human-readable 5-character code. Customers and
--    agents read these out over the phone, so the alphabet omits I, L, O, U, 0
--    and 1. The long reference stays in place for tracking and search.
--
-- 2. activity_log records every insert/update/delete across the application
--    tables, so there is one place to answer "who changed what, and when",
--    including agent registrations, wallet movements and price edits.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Short order codes
-- ---------------------------------------------------------------------------

-- 32 unambiguous characters (Crockford-style), so 5 chars gives 33.5M codes.
create or replace function public.new_short_code(p_table text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  v_code text;
  v_taken boolean;
  v_attempts integer := 0;
begin
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::integer, 1);
    end loop;

    execute format('select exists (select 1 from public.%I where short_code = $1)', p_table)
      into v_taken using v_code;

    exit when not v_taken;

    v_attempts := v_attempts + 1;
    if v_attempts > 50 then
      raise exception 'Unable to generate a unique short code for %', p_table;
    end if;
  end loop;

  return v_code;
end;
$$;

revoke all on function public.new_short_code(text) from public, anon, authenticated;

-- The default generates the code, so no application code has to change: every
-- insert (including the ones performed inside the reserve RPCs) gets one.
alter table public.agent_data_orders
  add column if not exists short_code text;

update public.agent_data_orders
set short_code = public.new_short_code('agent_data_orders')
where short_code is null;

alter table public.agent_data_orders
  alter column short_code set default public.new_short_code('agent_data_orders'),
  alter column short_code set not null;

create unique index if not exists agent_data_orders_short_code_idx
  on public.agent_data_orders (short_code);

alter table public.public_data_orders
  add column if not exists short_code text;

update public.public_data_orders
set short_code = public.new_short_code('public_data_orders')
where short_code is null;

alter table public.public_data_orders
  alter column short_code set default public.new_short_code('public_data_orders'),
  alter column short_code set not null;

create unique index if not exists public_data_orders_short_code_idx
  on public.public_data_orders (short_code);

-- ---------------------------------------------------------------------------
-- 2. Activity log
-- ---------------------------------------------------------------------------
create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id text,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_agent_code text,
  summary text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_created_idx on public.activity_log (created_at desc);
create index if not exists activity_log_actor_idx on public.activity_log (actor_user_id, created_at desc);
create index if not exists activity_log_table_idx on public.activity_log (table_name, created_at desc);

-- 2a. Generic row-level trigger. This is what makes the log complete: it fires
--     for every write regardless of which client made it (edge function, SQL
--     editor, dashboard, RPC).
create or replace function public.log_row_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_agent_code text;
  v_record_id text;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    select agent_code into v_agent_code from public.agents where id = v_actor;
  end if;

  v_record_id := coalesce(
    to_jsonb(coalesce(new, old)) ->> 'id',
    to_jsonb(coalesce(new, old)) ->> 'payment_reference',
    to_jsonb(coalesce(new, old)) ->> 'provider_reference'
  );

  insert into public.activity_log
    (table_name, record_id, action, actor_user_id, actor_agent_code, summary, old_data, new_data)
  values (
    tg_table_name,
    v_record_id,
    lower(tg_op),
    v_actor,
    v_agent_code,
    tg_table_name || ' ' || lower(tg_op) || coalesce(' (id ' || v_record_id || ')', ''),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public.log_row_activity() from public, anon, authenticated;

-- 2b. Attach to every application table that represents an activity.
--     to_regclass guards the loop: a few of these tables live outside this
--     migration set, and the log must not fail to install because of one.
do $$
declare
  t text;
begin
  foreach t in array array[
    'agents', 'profiles', 'wallets', 'wallet_transactions', 'wallet_topups',
    'cashout_deposit_requests', 'airtime_orders', 'utility_orders',
    'agent_data_orders', 'public_data_orders', 'results_orders',
    'result_checker_pins', 'service_pricing', 'agent_pricing',
    'afa_registrations'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('drop trigger if exists trg_activity_log_%s on public.%I', t, t);
    execute format(
      'create trigger trg_activity_log_%s
         after insert or update or delete on public.%I
         for each row execute function public.log_row_activity()', t, t);
  end loop;
end;
$$;

-- 2c. Manual logging for events that are not table writes (sign-ins, provider
--     calls, exports) so the trail is not limited to row changes.
create or replace function public.log_activity(
  p_summary text,
  p_meta jsonb default null,
  p_actor_user_id uuid default null
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_agent_code text;
  v_id bigint;
begin
  v_actor := coalesce(p_actor_user_id, auth.uid());

  if v_actor is not null then
    select agent_code into v_agent_code from public.agents where id = v_actor;
  end if;

  insert into public.activity_log (table_name, record_id, action, actor_user_id, actor_agent_code, summary, new_data)
  values ('activity', null, 'insert', v_actor, v_agent_code, p_summary, p_meta)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_activity(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.log_activity(text, jsonb, uuid) to authenticated, service_role;

-- 2d. Read access: an agent sees their own trail, an admin sees everything.
alter table public.activity_log enable row level security;

drop policy if exists "Agents read their own activity" on public.activity_log;
create policy "Agents read their own activity"
  on public.activity_log for select
  to authenticated
  using (
    actor_user_id = auth.uid()
    or exists (
      select 1 from public.agents a
      where a.id = auth.uid() and a.role = 'admin'
    )
  );

-- 2e. Convenience view: the activity trail with the agent's name resolved.
create or replace view public.activity_feed
with (security_invoker = true) as
select
  l.id,
  l.created_at,
  l.action,
  l.table_name,
  l.record_id,
  l.actor_user_id,
  l.actor_agent_code,
  coalesce(a.full_name, l.actor_agent_code) as actor_name,
  l.summary,
  l.old_data,
  l.new_data
from public.activity_log l
left join public.agents a on a.id = l.actor_user_id;
