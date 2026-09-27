-- ---------------------------------------------------------------------------
-- Harden the activity log
--
-- An audit trigger that can abort the business write it is observing is worse
-- than no audit trail: a malformed row in activity_log would start rejecting
-- wallet debits and order inserts. Two changes:
--
--   1. The log insert is wrapped so any failure is swallowed. The underlying
--      INSERT/UPDATE/DELETE always proceeds.
--   2. actor_user_id keeps the raw uuid with no foreign key, so deleting a user
--      (or a stale session) can never block a write on some unrelated table.
-- ---------------------------------------------------------------------------

-- The column is already uuid; only the foreign key has to go.
alter table public.activity_log
  drop constraint if exists activity_log_actor_user_id_fkey;

create or replace function public.log_row_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_agent_code text;
  v_record_id text;
  v_row jsonb;
begin
  -- Never let auditing break the write it is auditing.
  begin
    v_row := to_jsonb(coalesce(new, old));

    v_actor := auth.uid();
    if v_actor is not null then
      select agent_code into v_agent_code from public.agents where id = v_actor;
    end if;

    v_record_id := coalesce(
      v_row ->> 'id',
      v_row ->> 'payment_reference',
      v_row ->> 'provider_reference'
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
      case when tg_op in ('INSERT', 'UPDATE') then v_row else null end
    );
  exception when others then
    -- Swallowed on purpose: the caller still gets its row written.
    null;
  end;

  return coalesce(new, old);
end;
$$;

revoke all on function public.log_row_activity() from public, anon, authenticated;
