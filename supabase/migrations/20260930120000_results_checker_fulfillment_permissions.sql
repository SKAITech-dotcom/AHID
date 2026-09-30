-- Results checker PIN assignment is called by the create-result-checker-payment
-- Edge Function with the service-role client. Keep direct browser execution blocked.
grant execute on function public.fulfil_result_checker_order(uuid) to service_role;
