-- ============================================================================
-- Fix: agents' wallet balances were being reset to 0.00 by the frontend.
--
-- script.js ran, on every page load:
--     supabase.from('wallets').upsert({ id: userId, balance: 0.00 },
--                                   { onConflict: 'id' })
-- With onConflict the upsert overwrote the real balance, so a deposit credited
-- by Paystack was wiped the next time the agent loaded any page. The browser
-- was allowed to do this because of the "Agents can update their own wallet"
-- RLS policy.
--
-- 1. Rebuild every balance from wallet_transactions (the authoritative ledger).
-- 2. Remove the client UPDATE policy: a balance must only ever change through
--    the SECURITY DEFINER RPCs (charge_agent_wallet / refund_agent_wallet /
--    fulfil_wallet_topup), never from a browser.
-- 3. Re-scope the INSERT policy so a browser can only ever create a zero
--    balance row, never mint one.
-- ============================================================================

-- 1. Rebuild balances from the ledger.
update public.wallets w
set balance = coalesce((
      select sum(case when t.type = 'credit' then t.amount else -t.amount end)
      from public.wallet_transactions t
      where t.agent_id = w.id
    ), 0),
    updated_at = now();

-- 2. Balances are server-only now.
drop policy if exists "Agents can update their own wallet" on public.wallets;

-- 3. A browser may create its own wallet row, but only ever empty.
drop policy if exists "Agents can insert their own wallet" on public.wallets;
create policy "Agents can insert their own wallet"
  on public.wallets for insert
  with check (auth.uid() = id and balance = 0);
