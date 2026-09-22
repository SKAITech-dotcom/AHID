# Active context

**Current focus** (one short paragraph):

Agent portal navigation unified: `agentNav.js` shell now runs on every agent-facing page (dashboard, orders, airtime, instant data, utility bills, results checker, wallet, deposit, settings) with a persistent left sidebar on desktop (`body.agent-shell-agent`) plus the existing mobile drawer. Sidebar duplicate Dashboard removed; a Settings page (details + credentials + last login) added to the portal.

**In progress**:

- [ ] Manual browser QA of the unified agent sidebar + Settings page across pages (desktop + mobile) against remote Supabase project.

**Decisions (recent)**:

- Instant Data page restyled to a dark card theme (`#121212` bg, `#ffcc00` gold accents, white typography). Bundles now render as stacked full-width rows with "Data Bundle" size on the left and "Cost" price on the right; added a gold "Low Cost Non Expiry Bundles" subtitle band under the header. Bundle catalog/prices unchanged (backend still enforces them).

- `agentNav.js` bug fixed: `loadShell(isAgentursive ? true : isAgent)` -> `loadShell(isAgent)`; header call tidied.
- Added `.agent-shell-agent` body class; CSS (`css/style.css`) turns `.side-drawer` into a persistent sidebar on `>=992px` for agents (margin-left 280px, overlay hidden), drawer still used on small screens.
- Wired `agentNav.js` into `instantData.html`, `resultsChecker.html` (added FA CDN), `agentWallet.html`, `deposit.html` (removed their inline headers/back links). Removed "Back to Home" (`index.html`) links from instant data + results checker.
- Fixed case mismatch: references to `agentwallet.html` -> `agentWallet.html` (dashboard.html, script.js) so wallet links don't 404 on case-sensitive hosts.
- Agent gating stays server-side (`check-agent-access`); `handleAirtimeClick`/`handleUtilityClick` already route verified agents to services inside the portal.
- Removed duplicated hardcoded Dashboard item in `agentNav.js` `drawerHtml` (was rendered in addition to `AGENT_PORTAL_ITEMS[0]`).
- Added `settings.html` + `settings.js`: account overview (name, agent code, email, phone, role, last login from `user.last_sign_in_at`), update details (profiles + agents upsert + auth metadata), update credentials via `supabase.auth.updateUser`, sign-out after credential change. Guarded by `requireVerifiedAgent`.

**Open questions**:

- None.

_Update when the task or branch focus changes._
