-- Reconcile the admin wallet dashboard's cumulative totals from all historical
-- records before returning the summary. The wallet columns remain the durable
-- display values, but older rows may predate the current top-up/order RPCs.

create or replace function public.get_admin_wallet_lifetime_totals()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_totals jsonb;
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Admin access required.';
  end if;

  -- Deposits and sales are lifetime cumulative values. Use the larger of the
  -- stored counter and its historical source so legacy records are recovered
  -- without deleting valid older accounting that is not in a newer table.
  update public.wallets w
  set deposits = greatest(
        coalesce(w.deposits, 0),
        coalesce((
          select sum(t.amount)
          from public.wallet_topups t
          where t.agent_id = w.id and t.status = 'paid'
        ), 0)
      ),
      sales = greatest(
        coalesce(w.sales, 0),
        coalesce((
          select sum(tx.amount)
          from public.wallet_transactions tx
          where tx.agent_id = w.id
            and tx.type = 'debit'
            and tx.status = 'settled'
            and coalesce(tx.meta->>'manual_adjustment', 'false') <> 'true'
        ), 0),
        coalesce((
          select sum(o.amount)
          from public.orders o
          where o.agent_id = w.id
            and o.status in ('completed', 'success', 'paid')
        ), 0)
      ),
      updated_at = now()
  where exists (
    select 1
    from public.agents a
    where a.id = w.id
      and lower(coalesce(a.role, 'agent')) = 'agent'
  );

  select jsonb_build_object(
    'balance', round(coalesce(sum(w.balance), 0), 2),
    'commissionBalance', round(coalesce(sum(w.commission_balance), 0), 2),
    'deposits', round(coalesce(sum(w.deposits), 0), 2),
    'sales', round(coalesce(sum(w.sales), 0), 2),
    'agentCount', count(*)
  )
  into v_totals
  from public.wallets w
  join public.agents a on a.id = w.id
  where lower(coalesce(a.role, 'agent')) = 'agent';

  return coalesce(v_totals, jsonb_build_object(
    'balance', 0,
    'commissionBalance', 0,
    'deposits', 0,
    'sales', 0,
    'agentCount', 0
  ));
end;
$$;

revoke all on function public.get_admin_wallet_lifetime_totals() from public, anon;
grant execute on function public.get_admin_wallet_lifetime_totals() to authenticated, service_role;

