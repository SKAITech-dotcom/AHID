-- Let an agent read their OWN instant data orders from the browser.
--
-- instantData.html buys through create-public-data-payment, which writes to
-- public_data_orders with agent_id set to the buying agent. That table has had
-- RLS enabled since it was created but never had a single policy, so every
-- read was denied: the agent Orders page could not show instant data purchases
-- even though it already showed airtime, utility and data bundles.
--
-- Select only, scoped to the caller's own rows. Writes stay behind the
-- service-role Edge Functions, which is what keeps the public storefront flow
-- (reference + email through get-public-data-order) working unchanged, and
-- means an agent still cannot read another agent's orders or touch any row.
alter table public.public_data_orders enable row level security;

drop policy if exists "Agents can view their own instant data orders" on public.public_data_orders;
create policy "Agents can view their own instant data orders"
  on public.public_data_orders
  for select
  to authenticated
  using (agent_id = (select auth.uid()));

-- The orders page reads this to populate the Instant Data tab. Without an index
-- the policy is evaluated per row and the agent's own history gets slower as it
-- grows; agent_data_orders already has the equivalent index.
create index if not exists public_data_orders_agent_created_idx
  on public.public_data_orders (agent_id, created_at desc);