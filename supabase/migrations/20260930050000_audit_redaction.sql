-- ---------------------------------------------------------------------------
-- Redact secrets from audit rows
--
-- The activity log stores the full before/after row so a change can be
-- reconstructed. On the provider order tables that row includes
-- `provider_response`, which used to hold the provider's `identity` object
-- (API key + password hash).
--
-- Two problems that this migration closes:
--   1. Scrubbing a leaked secret from provider_response would copy the secret
--      into activity_log via this same trigger, so the leak would follow us.
--   2. Any remaining old rows should not be readable through the audit view.
--
-- Sensitive keys are blanked before the row is written, so the audit trail can
-- never become a second place the secret lives.
-- ---------------------------------------------------------------------------

create or replace function public.redact_audit_row(p_row jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case
    when p_row is null then null
    else
      p_row
      - 'identity'
      || jsonb_build_object('identity', case
            when p_row ? 'identity' and p_row -> 'identity' is not null
              then '[redacted]'
            else null
         end)
      - 'provider_response'
      || jsonb_build_object(
           'provider_response',
           case
             when p_row ? 'provider_response' and p_row -> 'provider_response' is not null
               then coalesce(p_row -> 'provider_response', '{}'::jsonb)
                      - 'identity'
                      - 'apiKey'
                      - 'api_key'
                      - 'password'
                      - 'token'
                      - 'secret'
             else null
           end)
  end;
$$;

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
      case when tg_op in ('UPDATE', 'DELETE') then public.redact_audit_row(to_jsonb(old)) end,
      case when tg_op in ('INSERT', 'UPDATE') then public.redact_audit_row(v_row) end
    );
  exception when others then
    -- Swallowed on purpose: the caller still gets its row written.
    null;
  end;

  return coalesce(new, old);
end;
$$;

revoke all on function public.log_row_activity() from public, anon, authenticated;
revoke all on function public.redact_audit_row(jsonb) from public, anon, authenticated;
grant execute on function public.redact_audit_row(jsonb) to service_role;

-- Re-run the self-test against the redacting trigger, so a regression in the
-- redaction logic fails the migration instead of quietly logging secrets.
create table public.activity_log_selftest (
  id uuid primary key default gen_random_uuid(),
  label text,
  provider_response jsonb
);

create trigger trg_activity_log_selftest
  after insert or update or delete on public.activity_log_selftest
  for each row execute function public.log_row_activity();

do $$
declare
  v_logged jsonb;
begin
  insert into public.activity_log_selftest (label, provider_response)
  values ('selftest', '{"identity":{"apiKey":"should-not-be-logged","password":"nope"},"status":"PENDING"}'::jsonb);

  select new_data into v_logged
  from public.activity_log
  where table_name = 'activity_log_selftest'
  order by id desc
  limit 1;

  if v_logged is null or v_logged ->> 'label' <> 'selftest' then
    raise exception 'ACTIVITY LOG SELF-TEST FAILED: the audit trigger did not record the insert';
  end if;

  if (v_logged #>> '{provider_response,identity,apiKey}') is not null
     or (v_logged #>> '{provider_response,identity}') is not null
     or (v_logged #>> '{provider_response,identity,password}') is not null then
    raise exception 'REDACTION SELF-TEST FAILED: provider credentials reached the activity log';
  end if;

  if v_logged #>> '{provider_response,status}' <> 'PENDING' then
    raise exception 'REDACTION SELF-TEST FAILED: redaction dropped non-sensitive fields';
  end if;

  delete from public.activity_log where table_name = 'activity_log_selftest';
end;
$$;

drop trigger if exists trg_activity_log_selftest on public.activity_log_selftest;
drop table if exists public.activity_log_selftest;
