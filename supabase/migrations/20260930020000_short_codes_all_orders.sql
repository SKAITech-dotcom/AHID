-- ---------------------------------------------------------------------------
-- Short order codes for the remaining order tables
--
-- The data order tables already carry a 5-character short_code. Applying the
-- same column default to airtime, utility and result-checker orders means every
-- order ID the agent sees is the same length, and because the code is generated
-- by the column default, no application code has to change to produce it.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'airtime_orders', 'utility_orders', 'results_orders', 'wallet_topups'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    execute format('alter table public.%I add column if not exists short_code text', t);

    execute format(
      'update public.%I set short_code = public.new_short_code(%L) where short_code is null', t, t);

    execute format(
      'alter table public.%I
         alter column short_code set default public.new_short_code(%L),
         alter column short_code set not null', t, t);

    execute format('create unique index if not exists %I_short_code_idx on public.%I (short_code)', t, t);
  end loop;
end;
$$;
