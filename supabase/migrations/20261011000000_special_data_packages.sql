-- ============================================================================
-- Named special data packages: Kokrokoo, Midnight and Voice
-- ============================================================================
-- The user asked for the special network packages (Kokrokoo, Midnight, Voice)
-- to be present in the storefront. They could not be delivered until a Hubtel
-- package id is mapped, so every row below ships is_available = false, exactly
-- like the rest of the seed in 20261006000000_hubtel_data_platform.sql.
-- Unavailable rows are excluded by the bundles RLS SELECT policy, so none of
-- these can appear on a page or be bought until hubtel_package_id is filled in
-- and is_available is flipped on - see HUBTEL_DATA_SETUP.md.
--
-- Prices below are PLACEHOLDER SALE prices, not Hubtel figures. 20261006000000
-- deliberately left these products out because "a price on screen with no cost
-- basis" is how a storefront over-promises. They are still gated off, so no
-- customer ever sees them; the recorded figure is only what the catalogue would
-- quote if someone maps the id and flips availability without updating the
-- price first. Doing that is logged in the migration history and must be
-- reconciled against Hubtel's real catalogue before enabling.
--
-- Voice bundles have no data volume, but the schema requires volume_mb > 0 and
-- the purchase path is denominated in MB. These rows carry a nominal volume
-- placeholder and a loud unavailable_reason so a Voice order can never be
-- placed until their data model is clarified with Hubtel.

insert into public.bundles
  (bundle_key, network_id, title, data_amount, volume_mb, price, category, validity,
   sort_order, is_available, unavailable_reason, provider_cost)
values
  -- MTN Kokrokoo (duration data packs)
  ('mtn-kokrokoo-1gb', 'mtn', 'Kokrokoo 1GB', '1GB', 1024, 6.00, 'Kokrokoo', '2 days',
   230, false, 'Placeholder price. Map hubtel_package_id and confirm the price against the Hubtel catalogue before enabling.', 5.20),
  ('mtn-kokrokoo-4gb', 'mtn', 'Kokrokoo 4GB', '4GB', 4096, 24.00, 'Kokrokoo', '7 days',
   231, false, 'Placeholder price. Map hubtel_package_id and confirm the price against the Hubtel catalogue before enabling.', 20.80),
  -- MTN Midnight (night-time data)
  ('mtn-midnight-1gb', 'mtn', 'Midnight 1GB', '1GB', 1024, 5.00, 'Midnight', NULL,
   232, false, 'Placeholder price. Map hubtel_package_id and confirm the price against the Hubtel catalogue before enabling.', 4.30),
  ('mtn-midnight-3gb', 'mtn', 'Midnight 3GB', '3GB', 3072, 12.00, 'Midnight', NULL,
   233, false, 'Placeholder price. Map hubtel_package_id and confirm the price against the Hubtel catalogue before enabling.', 10.40),
  -- AirtelTigo Midnight (night-time data)
  ('at-midnight-1gb', 'at', 'Midnight 1GB', '1GB', 1024, 5.00, 'Midnight', NULL,
   234, false, 'Placeholder price. Map hubtel_package_id and confirm the price against the Hubtel catalogue before enabling.', 4.20),
  -- Voice bundles all share the nominal volume placeholder described above.
  ('mtn-voice-30', 'mtn', 'MTN Voice 30M', '30 minutes', 1, 9.50, 'Voice', NULL,
   235, false, 'Voice bundles have no data volume. Clarify the fulfilment model with Hubtel before enabling.', 8.00),
  ('telecel-voice-30', 'telecel', 'Telecel Voice 30M', '30 minutes', 1, 9.50, 'Voice', NULL,
   236, false, 'Voice bundles have no data volume. Clarify the fulfilment model with Hubtel before enabling.', 8.00),
  ('at-voice-30', 'at', 'AT Voice 30M', '30 minutes', 1, 9.50, 'Voice', NULL,
   237, false, 'Voice bundles have no data volume. Clarify the fulfilment model with Hubtel before enabling.', 8.00)
on conflict (bundle_key) do update
  set network_id = excluded.network_id,
      title = excluded.title,
      data_amount = excluded.data_amount,
      volume_mb = excluded.volume_mb,
      price = excluded.price,
      category = excluded.category,
      validity = excluded.validity,
      sort_order = excluded.sort_order,
      unavailable_reason = excluded.unavailable_reason,
      updated_at = now();