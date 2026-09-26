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

**Not started / backlog**

- `GRANDTECH_API_KEY` (+ `GRANDTECH_AFA_PRICE_ID`, `GRANDTECH_AFA_CALLBACK`) are still unset, so AFA provider submission fails and auto-refunds. Needs the user's GrandTechHub credentials via `supabase secrets set`.
- Frontend is live on Vercel, so GitHub pushes do not reach the phone until a Vercel redeploy.
- Hubtel Airtime live integration (awaiting API creds); `_shared/airtimeProvider.ts` still returns `pending_provider`.
- Hubtel Instant Data API integration (current delivery via remadata).
- Browser QA of unified agent sidebar (desktop + mobile) and Instant Data end-to-end on remote.

**Known issues**

- None confirmed. Keep airtime RLS permissive (`select using(true)`) intentionally.

_Keep bullets factual and small; link issues or PRs when useful._
