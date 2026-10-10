-- ============================================================================
-- Fix: wallet refunds could never complete
-- ============================================================================
--
-- Two functions written in 20260923120000 end with:
--
--     update public.wallet_transactions
--        set status = 'refunded', updated_at = now()
--      where id = v_debit.id;
--
-- but `wallet_transactions` has never had an `updated_at` column. Postgres
-- rejects the statement with 42703 (column does not exist), and because the
-- statement sits inside the same transaction as everything before it, the whole
-- refund rolls back - including the credit row inserted two lines earlier. The
-- caller gets an exception instead of a new balance.
--
-- The two functions affected are on the exact paths that are supposed to give
-- money back:
--
--   refund_agent_wallet()      - every auto-refund in the project: failed
--                                deliveries, cancelled orders, declined
--                                airtime, utility failures.
--   complete_agent_data_order()- the failure branch of an agent data order.
--
-- So in practice a failed order left the customer charged, with a visible error
-- rather than a refund. The rows rolled back cleanly, so the ledger was never
-- left half-written - it simply never refunded anything.
--
-- The fix is to add the column the functions expect. It is also genuinely worth
-- having: `wallet_transactions.status` is mutable ('settled' -> 'refunded' ->
-- 'reversed'), and a ledger row that changes state with no timestamp of when it
-- changed cannot answer "when was this reversed", which is exactly the question
-- an audit trail exists to answer.
--
-- Found by the validation probe for 20261006000000 while driving a real
-- charge + refund through both RPCs; the charge succeeded and the refund blew
-- up. Reproducible on demand against the live database.
-- ============================================================================

alter table public.wallet_transactions
  add column if not exists updated_at timestamptz not null default now();

-- Existing rows were stamped with the migration's own timestamp by the column
-- default, which would be a lie about when they last changed. Their only honest
-- answer is "they have not been modified since they were created".
update public.wallet_transactions
   set updated_at = created_at
 where updated_at is distinct from created_at;

-- The status column is updated by three different functions, two of which
-- mention updated_at and one of which (agent_referral_store) does not. A
-- trigger keeps the value correct regardless of which code path wrote it,
-- rather than relying on every future UPDATE remembering to set it.
create or replace function public.touch_wallet_transaction_updated_at()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     or new.balance_after is distinct from old.balance_after then
    new.updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_transactions_touch_updated_at on public.wallet_transactions;
create trigger wallet_transactions_touch_updated_at
  before update on public.wallet_transactions
  for each row execute function public.touch_wallet_transaction_updated_at();

comment on column public.wallet_transactions.updated_at is
  'Last time this ledger row changed status or balance_after. Set by trigger so no update path can forget it.';