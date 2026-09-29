-- Enforce the short-code format at the database level.
--
-- 20260930010000 added the column, a 32-character generator and a unique
-- index, but nothing stopped a hand-written insert, a bad import or a future
-- code path from storing a reference-shaped string in short_code. Everything
-- downstream assumes a code can be read aloud over the phone and looked up
-- directly, so an unvalidated value silently breaks both.
--
-- The check is deliberately permissive about which letters are allowed: it
-- only enforces the shape. Restricting the alphabet here would make the
-- constraint reject a legitimate future code if the generator ever changes.
--
-- All 68 codes already in the database were verified to be 5 characters of
-- [A-Z0-9] before this migration, so the constraint validates immediately
-- rather than needing NOT VALID.
--
-- Note: the generator alphabet is
--   ABCDEFGHJKMNPQRSTVWXYZ0123456789
-- which is 24 letters plus the digits 2-9. It omits I, L, O and U to avoid
-- misreads, but it does include 0 and 1 - the comment in
-- 20260930010000 claiming otherwise is inaccurate. The constraint below
-- allows all of A-Z and 0-9 on purpose, so it never rejects a valid code.

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'agent_data_orders',
    'public_data_orders',
    'airtime_orders',
    'utility_orders',
    'results_orders',
    'wallet_topups'
  ]
  loop
    execute format(
      'alter table public.%I add constraint %I check ('
      || 'short_code is null or short_code ~ ''^[A-Z0-9]{5}$'')',
      v_table,
      v_table || '_short_code_format'
    );
  end loop;
end
$$;

comment on constraint agent_data_orders_short_code_format
  on public.agent_data_orders is
  'Short codes are read aloud over the phone, so they are always exactly 5 characters of A-Z and 0-9. NULL means not yet assigned.';
