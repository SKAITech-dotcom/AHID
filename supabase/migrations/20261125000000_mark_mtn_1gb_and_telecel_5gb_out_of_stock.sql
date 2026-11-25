-- Standard Data stock change:
--   * MTN 1GB is out of stock.
--   * Telecel 5GB is out of stock.
--
-- Provider routing is intentionally unchanged: both tiers remain assigned to
-- GrandTech when they are brought back into stock.

update public.bundle_catalog
set active = false,
    inactive_reason = 'Temporarily out of stock.',
    updated_at = now()
where bundle_id in ('mtn-1gb', 'telecel-5gb');
