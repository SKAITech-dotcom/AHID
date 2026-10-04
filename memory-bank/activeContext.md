# Active context

**Current focus** (one short paragraph):

Wiring Instant Data into the agent **Orders page** (`orders.html`), which is where an agent actually tracks what they bought. Instant data purchases are written to `public_data_orders`, a *different* table from the `agent_data_orders` the page already reads, so they have never appeared there. Two live defects surfaced while doing this: `public_data_orders` had RLS enabled with **zero** policies, so an agent could not read their own rows at all, and `get-public-data-order` selects a column `buyer_agent_id` that does not exist (it is `agent_id`), which made that function 404 on every call and silently disabled delivery confirmation and auto-refund. Migrations `20260930000000`-`20260930090000` are applied to `mxovqblxizvjsmudjsjf`. Still open from the previous pass: the duplicate site at `/SKAITechgh/`, the octet-stream sitemap, the undeliverable MB bundles, and four orders stuck in `processing`.

**In progress**:

- [ ] **Decide what to do about the duplicate site at `https://skaitechgh.wasmer.app/SKAITechgh/`.** A stale nested copy of 38 site files is tracked in git and served publicly. It has the old title "Skaitech - Fast & Reliable Mobile Data in Ghana", no canonical and no robots meta, so it is a live duplicate-content competitor for the pages we just asked Google to index. Nothing in robots.txt disallows it. Deleting it is the clean fix, but that is 38 files and needs confirming nothing references them.
- [ ] **`sitemap.xml` is served as `application/octet-stream`**, not `application/xml`. Wasmer's static server has no MIME mapping for `.xml` and there is no deploy config in the repo to change it. `robots.txt` (`text/plain`), `.html` and `.css` are all served correctly, so it is only the sitemap. Google usually still parses it, but it is a known cause of "Sitemap could not be read" on stricter crawlers. Needs either a Wasmer MIME/header mapping or a different way to serve the file.
- [ ] **The 5MB-200MB bundles are offered but cannot be delivered.** `instantData.js` and `create-public-data-payment` both list 5, 10, 20, 30, 50, 100, 150 and 200 MB per network, but GrandTechHub's smallest package is 1GB and `resolveGrandTechPackage` requires an exact `volumeInMB / 1024` match, so an MB request can never resolve. The Swift provider matches on a "N gb" label and cannot serve them either. The order is refused and refunded, so no money is lost, but a customer can pick a bundle that is guaranteed to fail. No MB order has ever been paid. Either drop them from the storefront or ask GrandTechHub for MB packages.
- [ ] **Four orders are stuck in `processing` with no provider acceptance** (MTN 1GB, 2026-09-09 to 2026-09-14, `provider_reference` NULL, `provider_amount` NULL, sale 4.20 and 15.00). They predate the status-tracking work. No `public_data_orders` row has ever reached `successful` or `failed`; the other 22 are `pending_payment`. Worth deciding whether to settle the four as failed and refund.
- [ ] Ask GrandTechHub to raise the cap on MTN 1GB (`196c301f-...`, `sales=1 limit=0`) and Telecel 5GB (`3bb260b3-...`, `sales=20 limit=20`). Confirm with them what `limit=0` means, since `sales=1` against it is self-contradictory. These two are the only capped packages out of 43.
- [ ] Submit `https://skaitechgh.wasmer.app/` in Google Search Console and Bing Webmaster Tools. The technical side is done, but a `wasmer.app` subdomain will not appear in search results until it is actually submitted and crawled; expect days, not minutes.

- The two agent order tables do not agree on column names: `agent_data_orders` uses `status` and `agent_id`, `airtime_orders` uses `airtime_status` and `user_id`. Anything that spans both has to branch on the column that is actually present rather than assuming a schema. The notification trigger reads the row through `to_jsonb()` for this reason.
- `escapeHtml` only exists on the AFA and admin pages, and `agentNav.js` loads before every other script on every agent page, so shared shell code cannot rely on it. `agentNav.js` has its own `escapeNotifText`.
- The project uses hand-written CSS and Font Awesome only - no Tailwind, no Lucide, no build step, no `package.json`. `css/style.css` has no custom properties, so dark mode is an override layer, not a variable flip.
- `.agent-portal-tag` had no CSS rule at all until commit `3daff82` and was rendering as bare text.
- Notifications are RLS-only on purpose: an edge function would need the service role and could read and dismiss other agents' notices, which the browser client cannot do. Notices are written by a trigger and never deleted by the client.

**Decisions (recent)**:

- Never trust a "done" report about a list of files without re-deriving the rule from the code. The crawler directives looked correct but two pages were simultaneously disallowed, indexable and in the sitemap; the truth came from reading the auth guards, not from the earlier summary.
- Checked the three SEO layers against each other programmatically (robots.txt vs sitemap.xml vs each page's meta) rather than by eye, and wrote the check to fail loudly on any disagreement. Two of my own test harnesses were wrong before they were right (a column that did not exist, and comparing a byte array against a regex), so a passing check is only worth something once it has been seen to fail.
- The short-code constraint was proved by generating 300 codes and by forcing a real violation, and the probe raises an exception so the transaction rolls itself back rather than relying on a cleanup step.
- The frontend hardcoded retail catalogs and the backend catalogs were compared programmatically and agree on all 31 whole-GB bundles. `agent_pricing` currently has 0 override rows, so the "displayed price vs charged price" gap is latent rather than costing money today.
- `instantData.html` and `airtime.html` are agent pages: they are not in `isPublicPage` or `isProtectedAgentPage` in `script.js`, but `agentNav.js` and each page's own script redirect anonymous users to login, so the page-level guard is what actually protects them.
- `localStorage.skaitech_orders` is a mixed bag, not just data: `instantData.js`, `nonAgentBuyers.js` **and `utilityBills.js`** all unshift into it. Anything that means "instant data orders" has to filter by reference prefix (`PUB-` / `DATA-`) rather than assume the cache is data-only, and it has to dedupe because only the utility writer checks for an existing reference.
- The agent Orders page and the customer storefront write to **two different tables**: `dashboard.html` -> `agent_data_orders` ("Data Bundle"), `instantData.html` -> `public_data_orders` ("Instant Data"). Both are tied to the buying agent via `agent_id`, but they are separate service keys on the orders page (`data` vs `instant_data`) and separate reconciliation paths. Anything touching orders has to decide which table it means before reading.
- A Supabase query builder is PromiseLike, not a Promise, so it has **no `.catch()`**. `await supabase.from(..).rpc(..).catch(..)` throws `TypeError: .catch is not a function`. Wrap it in `try`/`catch` or `.then(onOk, onErr)`.
- `public_data_orders` stores the provider's order id inside `provider_response->>'providerOrderId'` because the table has no `provider_order_id` column, unlike `agent_data_orders`. Anything reconciling instant data must read it from there.

- Verified a replacement provider key by SHA-256 before deploying it, rather than trusting that a pasted key was new. Also proved the endpoint actually enforces the key by checking that a bogus one gets 401. Both worth repeating for any future credential rotation.
- The provider reports an uncapped package as `limit = null` and a blocked one as a real number, so `0` is treated as zero allowed rather than "unset".

- Order IDs are shown as a 5-character code generated by a column default, but the long reference is kept everywhere internally so provider correlation and existing links keep working. `track-order` accepts either form.
- Provider acceptance is **not** delivery. A GrandTechHub acceptance stays `processing`; only a provider terminal state (or the stuck-order timer) settles it, and terminal failures refund the wallet idempotently.
- Canonical order states are `pending`, `processing`, `completed`, `failed`, `cancelled`. `pending` is reserved for the public Paystack window; it is not a normal data-order state.
- The activity log is written by a database trigger rather than application calls, so it captures writes from any client. Two deliberate safety properties: the trigger swallows its own errors (auditing must never block a business write), and `redact_audit_row()` strips provider credentials before the before/after rows are stored, so scrubbing a secret cannot copy it into the log.
- `provider_response` is no longer persisted wholesale; the GrandTech adapter whitelists safe fields. Migration `20260930060000` scrubbed the rows that predated that fix.
- Editing files with PowerShell `Set-Content`/`Get-Content` round-trips in this repo corrupts non-ASCII text: it adds a BOM, mangles the bullet character U+2022 into the three characters `a-circumflex, euro, quote`, and treats markdown backticks as escape sequences (so `` `r `` becomes a carriage return and silently swallows the following letter). Use the editor tools, or single-quoted PowerShell strings plus explicit UTF-8 reads/writes.
- The PowerShell console also renders correct UTF-8 as mojibake, so verify suspicious characters by codepoint (U+2304 = the down-arrowhead) before "fixing" them.
- Orders page: one status normaliser plus a cached full list, so search/filter/pagination never re-query. The Instant Data metric, service tab and table rows come from the same source as the other services.

**Open questions**:

- Whether to delete the duplicate `SKAITechgh/` directory, disallow it, or add a redirect to the canonical pages.
- Whether the MB bundles are a product decision (drop them) or a provider request (ask GrandTechHub for MB packages).
- Whether the activity log should also cover authentication events (sign-in, sign-out, failed logins). The current trigger only sees row writes, so those would need explicit calls.
- Whether historic activity should be backfilled; only changes made after migration `20260930010000` are recorded.

_Update when the task or branch focus changes._
