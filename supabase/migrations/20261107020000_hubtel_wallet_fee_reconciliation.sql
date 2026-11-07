-- Hubtel's successful Online Checkout callback reports the customer-paid
-- amount. The live callbacks showed GHS 1.01 for a GHS 1.00 wallet credit,
-- because Hubtel added its checkout charge. Reconcile those already-authenticated
-- callbacks now that the application accepts the provider gross amount.

do $$
declare
  v_topup record;
  v_callback_amount numeric;
  v_callback_amount_text text;
  v_expected_gross numeric;
begin
  for v_topup in
    select id, amount, gross_amount, provider_response
      from public.wallet_topups
     where provider = 'hubtel'
       and status = 'pending_payment'
       and provider_response is not null
       and coalesce(provider_response->>'ResponseCode', provider_response->>'responseCode') = '0000'
       and upper(coalesce(provider_response->>'Status', provider_response->>'status', '')) = 'SUCCESS'
     for update
  loop
    v_callback_amount_text := coalesce(
      v_topup.provider_response #>> '{Data,Amount}',
      v_topup.provider_response #>> '{data,Amount}',
      v_topup.provider_response #>> '{Data,amount}',
      v_topup.provider_response #>> '{data,amount}',
      v_topup.provider_response->>'Amount',
      v_topup.provider_response->>'amount'
    );
    if v_callback_amount_text !~ '^[0-9]+(\.[0-9]+)?$' then
      continue;
    end if;

    v_callback_amount := v_callback_amount_text::numeric;
    v_expected_gross := round(v_topup.amount * 1.01, 2);
    if round(v_callback_amount, 2) in (
      round(v_topup.amount, 2),
      round(coalesce(v_topup.gross_amount, 0), 2),
      v_expected_gross
    ) then
      perform public.fulfil_wallet_topup(v_topup.id);
    end if;
  end loop;
end;
$$;
