-- ---------------------------------------------------------------------------
-- Scrub leaked provider credentials
--
-- grandtechDataProvider.ts now whitelists the fields it persists, but rows
-- written before that fix still carry the provider's `identity` object
-- (API key + password hash) inside provider_response.
--
-- The audit trigger redacts identity/apiKey/password as of the previous
-- migration, so performing this scrub does not copy the secret into
-- activity_log.
-- ---------------------------------------------------------------------------

do $$
declare
  v_data integer := 0;
  v_public integer := 0;
begin
  update public.agent_data_orders
     set provider_response = (provider_response - 'identity' - 'apiKey' - 'api_key' - 'password' - 'token' - 'secret')
   where provider_response is not null
     and provider_response ? 'identity';

  get diagnostics v_data = row_count;

  update public.public_data_orders
     set provider_response = (provider_response - 'identity' - 'apiKey' - 'api_key' - 'password' - 'token' - 'secret')
   where provider_response is not null
     and provider_response ? 'identity';

  get diagnostics v_public = row_count;

  raise notice 'Scrubbed provider credentials: % agent data orders, % public data orders', v_data, v_public;
end;
$$;
