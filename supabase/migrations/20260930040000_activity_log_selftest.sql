-- ---------------------------------------------------------------------------
-- Activity log self-test
--
-- Proves the audit trigger actually records a row before any production traffic
-- depends on it. The test runs against a throwaway table, then removes both the
-- table and the log row it produced, so the log is left clean.
--
-- If the trigger is broken this migration FAILS loudly instead of silently
-- shipping an audit trail that records nothing.
-- ---------------------------------------------------------------------------

create table public.activity_log_selftest (
  id uuid primary key default gen_random_uuid(),
  label text
);

create trigger trg_activity_log_selftest
  after insert or update or delete on public.activity_log_selftest
  for each row execute function public.log_row_activity();

do $$
declare
  v_logged jsonb;
begin
  insert into public.activity_log_selftest (label) values ('selftest');

  select new_data into v_logged
  from public.activity_log
  where table_name = 'activity_log_selftest'
  order by id desc
  limit 1;

  if v_logged is null or v_logged ->> 'label' <> 'selftest' then
    raise exception 'ACTIVITY LOG SELF-TEST FAILED: the audit trigger did not record the insert';
  end if;

  -- Leave no trace of the test.
  delete from public.activity_log where table_name = 'activity_log_selftest';
end;
$$;

drop trigger if exists trg_activity_log_selftest on public.activity_log_selftest;
drop table if exists public.activity_log_selftest;
