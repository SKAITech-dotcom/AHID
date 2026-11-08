-- ---------------------------------------------------------------------------
-- Hubtel wallet settlement and agent price floors
--
-- Hubtel may report a fee-inclusive customer-paid Amount in the callback. The
-- wallet must receive the stored net amount, but a valid successful callback
-- must not be rejected just because the provider fee differs from the estimate
-- saved when checkout was initialized.
-- ---------------------------------------------------------------------------

do $$
declare
  v_topup record;
  v_amount_text text;
  v_callback_amount numeric;
  v_max_fee numeric;
begin
  for v_topup in
    select id, amount, provider_response
      from public.wallet_topups
     where provider = 'hubtel'
       and status = 'pending_payment'
       and provider_response is not null
       and coalesce(provider_response->>'ResponseCode', provider_response->>'responseCode') = '0000'
       and upper(coalesce(provider_response->>'Status', provider_response->>'status', '')) = 'SUCCESS'
     for update
  loop
    v_amount_text := coalesce(
      v_topup.provider_response #>> '{Data,AmountCharged}',
      v_topup.provider_response #>> '{data,AmountCharged}',
      v_topup.provider_response #>> '{Data,amountCharged}',
      v_topup.provider_response #>> '{data,amountCharged}',
      v_topup.provider_response #>> '{Data,Amount}',
      v_topup.provider_response #>> '{data,Amount}',
      v_topup.provider_response->>'AmountCharged',
      v_topup.provider_response->>'amountCharged',
      v_topup.provider_response->>'Amount',
      v_topup.provider_response->>'amount'
    );

    if v_amount_text !~ '^[0-9]+(\.[0-9]+)?$' then
      continue;
    end if;

    v_callback_amount := v_amount_text::numeric;
    v_max_fee := greatest(0.50, round(v_topup.amount * 0.05, 2));
    if v_callback_amount >= v_topup.amount
       and v_callback_amount <= v_topup.amount + v_max_fee then
      update public.wallet_topups
         set gross_amount = round(v_callback_amount, 2),
             fee_amount = round(v_callback_amount - amount, 2)
       where id = v_topup.id;
      perform public.fulfil_wallet_topup(v_topup.id);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform price floor for agent data-bundle pricing.
-- The current bundle_catalog price is the minimum an agent may publish or sell.
-- ---------------------------------------------------------------------------

create or replace function public.data_bundle_platform_floor(
  p_network text,
  p_package text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_network text := lower(trim(coalesce(p_network, '')));
  v_match text[];
  v_volume integer;
  v_price numeric;
begin
  if v_network in ('at', 'airtel-tigo', 'airtel_tigo') then
    v_network := 'airteltigo';
  end if;

  v_match := regexp_match(lower(trim(coalesce(p_package, ''))), '([0-9]+(?:\.[0-9]+)?)(gb|mb)');
  if v_match is null then return null; end if;

  v_volume := round((v_match[1])::numeric * case when v_match[2] = 'gb' then 1024 else 1 end)::integer;
  select round(price, 2)
    into v_price
    from public.bundle_catalog
   where lower(network) = v_network
     and volume_mb = v_volume
   order by active desc, updated_at desc
   limit 1;

  return v_price;
end;
$$;

create or replace function public.enforce_agent_data_price_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_network text;
  v_package text;
  v_price numeric;
  v_floor numeric;
begin
  if tg_table_name = 'agent_pricing' then
    if lower(coalesce(new.pricing_key, '')) not like 'price_%' then return new; end if;
    v_network := split_part(regexp_replace(lower(new.pricing_key), '^price_', ''), '_', 1);
    v_package := regexp_replace(regexp_replace(lower(new.pricing_key), '^price_[^_]+_', ''), '_', '-');
    v_price := new.price;
  elsif tg_table_name = 'agent_prices' then
    v_network := new.network;
    v_package := new.package_id;
    v_price := new.custom_price;
  elsif tg_table_name = 'store_products' then
    if lower(coalesce(new.product_type, '')) <> 'data_bundle' then return new; end if;
    v_network := split_part(replace(lower(new.product_ref), '_', '-'), '-', 1);
    v_package := regexp_replace(replace(lower(new.product_ref), '_', '-'), '^[^-]+-', '');
    v_price := new.price;
  else
    return new;
  end if;

  v_floor := public.data_bundle_platform_floor(v_network, v_package);
  if v_floor is not null and v_price < v_floor then
    raise exception 'Agent price for % % cannot be below the platform price of GHS %.',
      upper(v_network), upper(v_package), to_char(v_floor, 'FM999999990.00')
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_pricing_floor on public.agent_pricing;
create trigger trg_agent_pricing_floor
before insert or update of pricing_key, price on public.agent_pricing
for each row execute function public.enforce_agent_data_price_floor();

drop trigger if exists trg_agent_prices_floor on public.agent_prices;
create trigger trg_agent_prices_floor
before insert or update of network, package_id, custom_price on public.agent_prices
for each row execute function public.enforce_agent_data_price_floor();

drop trigger if exists trg_store_products_floor on public.store_products;
create trigger trg_store_products_floor
before insert or update of product_type, product_ref, price on public.store_products
for each row execute function public.enforce_agent_data_price_floor();

-- Normalize any already-saved values that are below today's platform floor.
update public.agent_pricing p
   set price = public.data_bundle_platform_floor(
     split_part(regexp_replace(lower(p.pricing_key), '^price_', ''), '_', 1),
     regexp_replace(regexp_replace(lower(p.pricing_key), '^price_[^_]+_', ''), '_', '-')
   )
 where lower(p.pricing_key) like 'price_%'
   and public.data_bundle_platform_floor(
     split_part(regexp_replace(lower(p.pricing_key), '^price_', ''), '_', 1),
     regexp_replace(regexp_replace(lower(p.pricing_key), '^price_[^_]+_', ''), '_', '-')
   ) is not null
   and p.price < public.data_bundle_platform_floor(
     split_part(regexp_replace(lower(p.pricing_key), '^price_', ''), '_', 1),
     regexp_replace(regexp_replace(lower(p.pricing_key), '^price_[^_]+_', ''), '_', '-')
   );

update public.agent_prices p
   set custom_price = public.data_bundle_platform_floor(p.network, p.package_id)
 where public.data_bundle_platform_floor(p.network, p.package_id) is not null
   and p.custom_price < public.data_bundle_platform_floor(p.network, p.package_id);

update public.store_products p
   set price = public.data_bundle_platform_floor(
     split_part(replace(lower(p.product_ref), '_', '-'), '-', 1),
     regexp_replace(replace(lower(p.product_ref), '_', '-'), '^[^-]+-', '')
   )
 where lower(p.product_type) = 'data_bundle'
   and public.data_bundle_platform_floor(
     split_part(replace(lower(p.product_ref), '_', '-'), '-', 1),
     regexp_replace(replace(lower(p.product_ref), '_', '-'), '^[^-]+-', '')
   ) is not null
   and p.price < public.data_bundle_platform_floor(
     split_part(replace(lower(p.product_ref), '_', '-'), '-', 1),
     regexp_replace(replace(lower(p.product_ref), '_', '-'), '^[^-]+-', '')
   );

-- Storefront visitors may read agent prices, but only the owning agent (or an
-- administrator) may write them. The edge function uses service_role for its
-- slug/code mirrors and remains able to write through RLS.
drop policy if exists "agent_prices_agent_write" on public.agent_prices;
drop policy if exists "Allow agents to manage their prices" on public.agent_prices;
create policy "Agents manage their own agent prices"
  on public.agent_prices for all
  to authenticated
  using (agent_id = auth.uid()::text or public.is_admin())
  with check (agent_id = auth.uid()::text or public.is_admin());

revoke insert, update, delete on public.agent_prices from anon;
grant select on public.agent_prices to anon, authenticated;
grant insert, update, delete on public.agent_prices to authenticated;

revoke execute on function public.data_bundle_platform_floor(text, text) from public, anon, authenticated;
