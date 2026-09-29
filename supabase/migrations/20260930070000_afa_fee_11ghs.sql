-- ---------------------------------------------------------------------------
-- Set the AFA registration fee to GHS 11.00
--
-- service_pricing is the source of truth: create-afa-registration charges this
-- figure, and both AFA forms read it to display the same number, so one row
-- keeps the quote and the charge in agreement.
--
-- The AFA_FEE_AMOUNT secret and the code fallbacks are set to match, so the
-- price stays 11.00 even if this table is ever cleared.
-- ---------------------------------------------------------------------------

insert into public.service_pricing (service, price, label)
values ('afa', 11.00, 'AFA Registration Fee')
on conflict (service) do update
  set price = excluded.price,
      label = excluded.label,
      updated_at = now();

do $$
declare
  v_price numeric;
begin
  select price into v_price from public.service_pricing where service = 'afa';
  if v_price is distinct from 11.00 then
    raise exception 'AFA price is %, expected 11.00', v_price;
  end if;
end;
$$;
