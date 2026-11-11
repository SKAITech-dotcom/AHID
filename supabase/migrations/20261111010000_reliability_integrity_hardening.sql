-- Reliability and integrity hardening discovered during the 2026-11-11
-- production audit. This migration does not create or dispatch any purchase.

-- A public tracker must be able to identify historical records that need
-- operator review without pretending that an unverified order was delivered.
alter table public.store_orders
  add column if not exists manual_review_required boolean not null default false,
  add column if not exists manual_review_reason text;

alter table public.public_data_orders
  add column if not exists manual_review_required boolean not null default false,
  add column if not exists manual_review_reason text;

create index if not exists store_orders_manual_review_idx
  on public.store_orders(manual_review_required, created_at desc)
  where manual_review_required;

create index if not exists public_data_orders_manual_review_idx
  on public.public_data_orders(manual_review_required, created_at desc)
  where manual_review_required;

-- Older store/public-data rows were written by legacy paths that could mark an
-- order successful without preserving a provider reference. Do not refund or
-- delete them based on incomplete evidence. Re-open them for reconciliation
-- and make the uncertainty explicit to the admin/operator paths.
update public.store_orders
   set fulfilment_status = 'processing',
       manual_review_required = true,
       manual_review_reason = coalesce(manual_review_reason, 'Legacy successful order has no provider reference; delivery must be verified.'),
       provider_state = coalesce(provider_state, 'unknown'),
       updated_at = now()
 where fulfilment_status = 'successful'
   and provider_reference is null;

update public.public_data_orders
   set status = 'processing',
       manual_review_required = true,
       manual_review_reason = coalesce(manual_review_reason, 'Legacy successful order has no provider reference; delivery must be verified.'),
       completed_at = null
 where status = 'successful'
   and provider_reference is null;

-- New terminal success states must carry the evidence needed for live status
-- tracking. Existing legacy rows are intentionally left untouched by this
-- trigger and were flagged above instead of being guessed into failed/refunded.
create or replace function public.guard_provider_confirmed_success()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'store_orders' and new.fulfilment_status = 'successful' then
    if new.payment_status <> 'paid' or nullif(trim(coalesce(new.provider_reference, '')), '') is null then
      raise exception 'A store order cannot be marked successful without paid status and a provider reference.';
    end if;
  elsif tg_table_name = 'public_data_orders' and new.status = 'successful' then
    if nullif(trim(coalesce(new.provider_reference, '')), '') is null then
      raise exception 'A public data order cannot be marked successful without a provider reference.';
    end if;
  elsif tg_table_name = 'agent_data_orders' and new.status = 'successful' then
    if nullif(trim(coalesce(new.provider_reference, '')), '') is null then
      raise exception 'An agent data order cannot be marked successful without a provider reference.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_store_provider_confirmed_success on public.store_orders;
create trigger trg_store_provider_confirmed_success
before insert or update of payment_status, fulfilment_status, provider_reference
on public.store_orders
for each row execute function public.guard_provider_confirmed_success();

drop trigger if exists trg_public_data_provider_confirmed_success on public.public_data_orders;
create trigger trg_public_data_provider_confirmed_success
before insert or update of status, provider_reference
on public.public_data_orders
for each row execute function public.guard_provider_confirmed_success();

drop trigger if exists trg_agent_data_provider_confirmed_success on public.agent_data_orders;
create trigger trg_agent_data_provider_confirmed_success
before insert or update of status, provider_reference
on public.agent_data_orders
for each row execute function public.guard_provider_confirmed_success();

revoke all on function public.guard_provider_confirmed_success() from public, anon, authenticated;

-- `create-result-checker-payment` is the only supported writer for result
-- orders. An old public INSERT policy allowed anonymous order-row spam and was
-- unnecessary because the Edge Function uses the service role.
drop policy if exists "Allow public insert on results_orders" on public.results_orders;

-- The 2026-10-30 hardening migration reset a small set of wallets to zero but
-- its follow-up audit insert ran after the reset and therefore recorded no
-- clearing debit. Reconcile only the accounting ledger to the already-stored
-- wallet balance; this does not change any wallet balance or move money.
do $$
declare
  v_row record;
  v_delta numeric;
begin
  for v_row in
    with ledger as (
      select agent_id,
             round(sum(case when type = 'credit' then amount
                              when type = 'debit' then -amount
                              else 0 end), 2) as ledger_balance
        from public.wallet_transactions
       group by agent_id
    )
    select w.id,
           round(coalesce(w.balance, 0), 2) as wallet_balance,
           round(coalesce(l.ledger_balance, 0), 2) as ledger_balance
      from public.wallets w
      join public.agents a on a.id = w.id
      left join ledger l on l.agent_id = w.id
     where lower(coalesce(a.role, 'agent')) = 'agent'
       and abs(round(coalesce(w.balance, 0) - coalesce(l.ledger_balance, 0), 2)) > 0.01
  loop
    v_delta := round(v_row.ledger_balance - v_row.wallet_balance, 2);
    if v_delta > 0 then
      insert into public.wallet_transactions
        (agent_id, reference, type, description, amount, balance_after, status, meta)
      values
        (v_row.id,
         'RECON-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
         'debit',
         'Accounting reconciliation for pre-ledger wallet reset',
         v_delta,
         v_row.wallet_balance,
         'settled',
         jsonb_build_object(
           'manual_adjustment', true,
           'reconciliation', true,
           'reason', 'Align historical wallet ledger with the already-stored wallet balance; no wallet balance was changed.'
         ));
    elsif v_delta < 0 then
      insert into public.wallet_transactions
        (agent_id, reference, type, description, amount, balance_after, status, meta)
      values
        (v_row.id,
         'RECON-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
         'credit',
         'Accounting reconciliation for pre-ledger wallet adjustment',
         abs(v_delta),
         v_row.wallet_balance,
         'settled',
         jsonb_build_object(
           'manual_adjustment', true,
           'reconciliation', true,
           'reason', 'Align historical wallet ledger with the already-stored wallet balance; no wallet balance was changed.'
         ));
    end if;
  end loop;
end;
$$;
