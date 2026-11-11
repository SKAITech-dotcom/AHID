-- The shared provider-success trigger serves three tables with different
-- status column names. Access NEW fields only after identifying the table:
-- PL/pgSQL records do not expose columns that are absent from their row type.
create or replace function public.guard_provider_confirmed_success()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'store_orders' then
    if new.fulfilment_status = 'successful'
       and (new.payment_status <> 'paid'
         or nullif(trim(coalesce(new.provider_reference, '')), '') is null) then
      raise exception 'A store order cannot be marked successful without paid status and a provider reference.';
    end if;
  elsif tg_table_name = 'public_data_orders' then
    if new.status = 'successful'
       and nullif(trim(coalesce(new.provider_reference, '')), '') is null then
      raise exception 'A public data order cannot be marked successful without a provider reference.';
    end if;
  elsif tg_table_name = 'agent_data_orders' then
    if new.status = 'successful'
       and nullif(trim(coalesce(new.provider_reference, '')), '') is null then
      raise exception 'An agent data order cannot be marked successful without a provider reference.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_provider_confirmed_success() from public, anon, authenticated;
