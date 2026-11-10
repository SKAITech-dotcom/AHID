-- Recover legacy GrandTech IDs only when the saved provider list contains an
-- order matching this row's recipient, network, bundle size, and creation time.
-- If any identifying field is missing, the row is intentionally left alone.

update public.agent_data_orders as local_order
set provider_order_id = (
  select item->>'orderId'
  from jsonb_array_elements(
    coalesce(local_order.provider_response->'livePayload'->'payload', '[]'::jsonb)
  ) as item
  where nullif(item->>'orderId', '') is not null
    and regexp_replace(coalesce(item->'packages'->0->>'phone', ''), '\\D', '', 'g') = regexp_replace(local_order.phone, '\\D', '', 'g')
    and upper(coalesce(item->'packages'->0->>'network', '')) = upper(local_order.network_type)
    and abs((item->'packages'->0->>'size')::numeric - (local_order.volume_mb::numeric / 1024)) < 0.000001
    and abs(extract(epoch from (local_order.created_at - (item->>'createdAt')::timestamptz))) <= 900
  order by abs(extract(epoch from (local_order.created_at - (item->>'createdAt')::timestamptz)))
  limit 1
)
where local_order.provider_name = 'grandtech'
  and local_order.provider_order_id is null
  and exists (
    select 1
    from jsonb_array_elements(
      coalesce(local_order.provider_response->'livePayload'->'payload', '[]'::jsonb)
    ) as item
    where nullif(item->>'orderId', '') is not null
      and regexp_replace(coalesce(item->'packages'->0->>'phone', ''), '\\D', '', 'g') = regexp_replace(local_order.phone, '\\D', '', 'g')
      and upper(coalesce(item->'packages'->0->>'network', '')) = upper(local_order.network_type)
      and abs((item->'packages'->0->>'size')::numeric - (local_order.volume_mb::numeric / 1024)) < 0.000001
      and abs(extract(epoch from (local_order.created_at - (item->>'createdAt')::timestamptz))) <= 900
  );
