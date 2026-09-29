# Progress

**What works**

- Unified agent portal sidebar: `agentNav.js` injected on dashboard, orders, airtime, instant data, utility bills, results checker, wallet, and deposit. Desktop gets a persistent sidebar (`>=992px`), mobile keeps the drawer.
- Removed "Back to Home" links/redirects that pulled logged-in agents out of the portal; agent brand/nav point to `dashboard.html`.
- Fixed `agentNav.js` runtime bug (`isAgentursive` typo) that broke shell boot.
- Removed duplicate Dashboard entry in the agent sidebar (hardcoded item on top of `AGENT_PORTAL_ITEMS`).
- New agent Settings page (`settings.html` + `settings.js`): shows last login, editable details (profiles/agents), and email/password change via `supabase.auth.updateUser` with sign-out after credential update.
- Wallet links de-cased: `agentwallet.html` -> `agentWallet.html` everywhere.
- Agent-only Airtime backend: `check-agent-access`, `create-airtime-payment` (requireAgent + idempotency), `get-airtime-order` (owner scoped), `agent-transactions`. All deployed to project `mxovqblxizvjsmudjsjf`.
- Migration `20260922_agent_transactions.sql` applied (idempotency_key + unique partial index).
- Instant Data: `instantData.html` + `instantData.js` — Hubtel-style network select (mtn/telecel/airteltigo), phone prefix auto-detection, bundle grid, sticky checkout, Paystack redirect via `create-public-data-payment`, return handling via `get-public-data-order` + local order cache. Restyled as dark card layout: `#121212` background, gold `#ffcc00` accents, stacked bundle rows (Data left / Cost right), "Low Cost Non Expiry Bundles" subtitle band.
- Agent gating redirect (not modal): `script.js` `handleAirtimeClick`/`handleUtilityClick` -> `redirectToAgentAuth`; `utilityBills.js` server check + redirect; `airtime.js` `enforceAgentAccess` redirects.
- `login.html` agent notice banner (`notice=agent`) + `redirect` return target after login/registration.
- Airtime transaction UI: summary stat cards, service tabs, status pills, Provider Ref column (`orders.html` + `css/style.css`).
- JS syntax checks pass (script.js, airtime.js, utilityBills.js, instantData.js, agentAccessCheck.js, agentNav.js, settings.js).
- **Wallet-first refactor (shipped, commit `731aa5d`)**: every purchase (airtime, utility, results checker, public/instant data, AFA) is paid from the verified agent wallet with atomic debit + automatic refund on provider failure. New `_shared/wallet.ts` (`chargeWallet`/`refundWallet`), `wallet_transactions` ledger + `charge_agent_wallet`/`refund_agent_wallet` RPCs (migration `20260923120000_wallet_first_audit.sql`). Paystack remains only the wallet-funding on-ramp. Frontends: resultsChecker, instantData, nonAgentBuyers, utilityBills, new `walletBalance.js` helper.
- **AFA via GrandTechHub**: new `_shared/afaProvider.ts`; `create-afa-registration` + `manage-afa-registrations` (create) now take `dateOfBirth` + `occupation` (+ `priceId`), charge the wallet, and auto-refund on provider rejection. DOB/occupation fields added to `AFA.html`/`AFA.JS` and `agentAFA.HTML`/`agentAFA.JS`.
- **Fixed: wallet top-ups never credited (migration `20260926000000_wallet_topup_credit_fix.sql`)**. Deployed `fulfil_wallet_topup` marked top-ups `paid` without crediting, so every balance stayed `0.00` and all purchases failed with "Insufficient wallet balance". Rewrote it to credit + write a ledger row (idempotent) and reconciled missed credits. Verified agent `3d50bc91` credited GHS 10.00 for the real Paystack txn `WAL-279aee15`.

- **Data bundle status tracking (migrations `20260930000000`-`20260930060000`, all applied)**: data orders use `pending|processing|successful|failed|cancelled`. `pending` is reserved for the Paystack window in the public flow; a GrandTechHub acceptance stays `processing` until delivery. Added `provider_name`/`provider_order_id` plus `record_agent_data_dispatch()`, `settle_agent_data_order()` (idempotent, refunds the wallet on terminal failure) and `mark_public_data_order()`. New Edge Function `sync-agent-data-order` reconciles on dashboard load; `get-public-data-order` does the same for public buyers.
- **5-character order codes**: `public.new_short_code(text)` generates a unique code used as a column default on `agent_data_orders`, `public_data_orders`, `airtime_orders`, `utility_orders`, `results_orders`, `wallet_topups`. Letter set omits I/L/O/U; all digits included. The long reference is unchanged, so provider correlation and existing links still work. Exposed by `agent-transactions`/`track-order` as `shortCode`, shown in the Order ID column, searchable, and `track-order` accepts a bare 5-character code.
- **Database-wide activity log**: `public.activity_log` (append-only) + `public.activity_feed` view, populated by an `after insert/update/delete` trigger on every application table, so writes are captured regardless of which client made them. Hardened after review: the trigger insert is wrapped in an exception handler so auditing can never block the business write; `actor_user_id` has no FK; `public.redact_audit_row()` strips `identity`/`apiKey`/`password`/`token`/`secret` from stored before/after rows. Agents read their own entries, admins read all. `log_activity()` records non-row events such as provider reconciliation.
- **Leaked provider credentials handled**: `grandtechDataProvider.ts` now whitelists persisted fields instead of storing the provider `identity` object, and migration `20260930060000` scrubbed the already-stored `provider_response.identity` from existing rows. The GrandTech API key should still be rotated, since it was previously exposed.
- **Orders page**: single status normaliser plus cached full-list filter/pagination, canonical badges for all five states, Instant Data metric + service tab + table rows, provider-ref column, table scroll containment, clear yellow page background, responsive grids/pagination. `instantData.js` and `nonAgentBuyers.js` no longer treat `processing` as failure. Removed a duplicate `DOMContentLoaded` handler that loaded orders (and reconciled providers) twice per visit.
- **AFA registration fee is GHS 11.00** (migration `20260930070000`, `AFA_FEE_AMOUNT=11`, code fallbacks 11). `service_pricing` is the source of truth: the charge and both AFA forms read the same row, so quote and charge cannot drift. Note the `service_pricing` select policy is `authenticated` only, so the public `AFA.html` cannot read it and must rely on its static `GHS 11.00` text.
- **Search visibility**: added `robots.txt` + `sitemap.xml` (11 public URLs), meta description / canonical / Open Graph / Twitter cards on every public page, `noindex` on the nine agent-gated pages, Organization + FAQPage JSON-LD, and `Skaitech Ghana`/`SkaitechGH` branding in the title so a search for "skaitechgh" matches. Also fixed three logo references that used a literal space instead of `%20`.
- **GrandTechHub API key rotated.** The leaked key was replaced via `supabase secrets set GRANDTECH_API_KEY=...`; the new key was hash-compared against the old one to confirm it was genuinely different, verified to authenticate (`GET /api/packages` returns 200 with it, 401 without), and the six functions that depend on it were redeployed. Combined with the scrub in migration `20260930060000`, the exposure is closed. Never store this key in a repo file.
- **Provider stock, live as of the last check (43 packages, 41 sellable):**
  - `196c301f-4709-4011-bba4-8fe9a0521003` MTN 1GB, price 392, `sales=1 limit=0`, type `EXPIRING` - blocked.
  - `3bb260b3-5f8b-489e-99c1-8acd1acda635` Telecel 5GB, price 1850, `sales=20 limit=20`, type `EXPIRING` - blocked.
  - Uncapped packages report `limit = null` (not `0`), so `0` genuinely means zero allowed. But `sales=1` against `limit=0` is self-contradictory and worth confirming with the provider before treating the block as correct.
- **Not started / backlog**

- **Airtime is now wallet-only (commit `9061f75`)**: `airtime.js` default `paymentMethod = 'wallet'`, gateway fee removed (fee always `0.00`, gross = net), FLOW B Paystack block deleted, `selectPaymentMethod` rejects non-wallet, balance now taken from the server's `walletBalance` via `applyWalletBalance`. `airtime.html` shows only the wallet card. `checkPaymentCallback` kept intentionally for pre-switch in-flight Paystack orders.
- `GRANDTECH_API_KEY` is set, but **`backend.grandtech.cloud` is NXDOMAIN** (confirmed via 8.8.8.8; apex `grandtech.cloud` -> 184.168.131.241, port 443 refused). The AFA host is wrong/unreachable, so AFA cannot complete. `_shared/afaProvider.ts` now reads `GRANDTECH_AFA_URL` (env, defaults to the documented URL) so the host is fixable via `supabase secrets set` with no redeploy.
- `GRANDTECH_AFA_PRICE_ID` and the real AFA price are still unknown; fee currently falls back to `AFA_FEE_AMOUNT` (GHS 8).
- AFA forms (agent + public) now clear the new DOB/occupation fields and apply the server `walletBalance`; the public form checks for an agent session on submit (tracker stays public).
- Canonical frontend host is Wasmer (`https://skaitechgh.wasmer.app/`), which builds from `main`, so a GitHub push is what reaches production.
- Hubtel Airtime live integration (awaiting API creds); `_shared/airtimeProvider.ts` still returns `pending_provider`.
- Hubtel Instant Data API integration (current delivery via remadata).
- Browser QA of unified agent sidebar (desktop + mobile) and Instant Data end-to-end on remote.
- **Rotate the GrandTech API key.** It was exposed in earlier provider responses; the stored copies are now scrubbed but the key itself must be replaced with `supabase secrets set GRANDTECH_API_KEY=...`.
- **GrandTechHub package caps block fulfilment**: MTN 1GB is `sales=1, limit=0` and Telecel 5GB is `sales=20, limit=20`. Both catalog entries need their caps raised before agents can sell them.
- **Unverified end-to-end**: no authenticated agent session is available in this environment, so dashboard sync, `track-order` short-code lookup and `agent-transactions` were verified with schema/response probes and `401` guards only.
- **Bundle prices are hardcoded in the frontend** while the backend honours `agent_pricing`, so the dashboard can quote a price that does not match the charge.
- **Unsupported 5MB-200MB bundles** are still listed on the dashboard; either remove them or route them to a provider that supports them.
- **Legacy storefront `?agent=` query parameters** are not scrubbed, so agent codes still leak through shared links.
**Known issues**
- GrandTechHub orders have never been observed reaching a successful terminal state; known orders remained `PENDING`/`PROCESSING`.

- None confirmed. Keep airtime RLS permissive (`select using(true)`) intentionally.

_Keep bullets factual and small; link issues or PRs when useful._
