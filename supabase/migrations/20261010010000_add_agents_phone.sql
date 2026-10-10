-- ============================================================================
-- Restore the missing `phone` column on `agents`
-- ============================================================================
-- The live `agents` table was rebuilt at some point (like `profiles`) and lost
-- its `phone` column, so every `agents` upsert that included `phone` failed and
-- the `sync_profile_identity` trigger (installed by 20261010000000) skipped
-- copying phone to `profiles` because the column did not exist.
--
-- The browser already writes `phone` (sign-in `ensureAgentProfile` upsert and
-- the Settings page) and the existing `Agents can update their own agent row`
-- RLS policy permits it; only the column was missing. Adding it here makes those
-- writes stick and lets the existing trigger mirror phone to `profiles`.
-- ============================================================================

alter table public.agents add column if not exists phone text;

-- Copy any phone now available on agents across to profiles (idempotent; the
-- trigger only fires on new writes, so historical rows need this one pass).
update public.profiles p
set phone = a.phone,
    updated_at = now()
from public.agents a
where a.id = p.id
  and a.phone is not null
  and p.phone is distinct from a.phone;