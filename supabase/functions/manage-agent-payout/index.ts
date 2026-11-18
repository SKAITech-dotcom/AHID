import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

/**
 * Payout capture for an agent store (captured now, executed later).
 *
 * An agent saves a payout destination once, then may request a payout up to the
 * earnings that have actually settled on their store. Nothing is transferred
 * here - a request lands as `requested` for an admin to approve and settle from
 * the console, so the money movement stays a deliberate manual step.
 *
 * Available balance = the wallet's commission balance minus open payout
 * reservations. Commission is deducted only when an admin records payment.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

const RESERVABLE_STATUSES = ['requested', 'approved', 'processing', 'pending'];

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user, agent } = await requireAgent(request);

    const { data: account } = await admin
      .from('agent_payout_accounts')
      .select('method, account_name, account_number, bank_name, momo_network')
      .eq('agent_id', user.id)
      .maybeSingle();

    if (request.method === 'GET') {
      const [walletRes, ordersRes, payoutsRes] = await Promise.all([
        admin.from('wallets').select('commission_balance, withdrawn_commission').eq('id', user.id).maybeSingle(),
        admin.from('store_orders')
          .select('agent_earning')
          .eq('agent_id', user.id)
          .eq('payment_status', 'paid')
          .eq('fulfilment_status', 'successful'),
        admin.from('agent_payouts')
          .select('id, amount, status, method, reference, admin_note, disbursement_reference, commission_debited, requested_at, paid_at')
          .eq('agent_id', user.id)
          .order('requested_at', { ascending: false })
          .limit(100),
      ]);
      if (walletRes.error) throw walletRes.error;
      if (ordersRes.error) throw ordersRes.error;
      if (payoutsRes.error) throw payoutsRes.error;

      const settled = (ordersRes.data ?? []).reduce((sum, row) => sum + Number(row.agent_earning || 0), 0);
      const committed = (payoutsRes.data ?? [])
        .filter((row) => RESERVABLE_STATUSES.includes(String(row.status)) && row.commission_debited !== true)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const commissionBalance = Number(walletRes.data?.commission_balance || 0);

      return json({
        account: account ?? null,
        balance: {
          settled: round2(settled),
          committed: round2(committed),
          available: round2(Math.max(0, commissionBalance - committed)),
          commissionBalance: round2(commissionBalance),
        },
        payouts: payoutsRes.data ?? [],
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const action = text(body.action, 30);

      if (action === 'save-account') {
        const method = text(body.method, 10).toLowerCase() || 'momo';
        if (!['momo', 'bank'].includes(method)) {
          return json({ error: 'Choose Momo or Bank as the payout method.' }, 400);
        }
        const accountName = text(body.accountName, 120);
        const accountNumber = text(body.accountNumber, 60);
        if (!accountName || !accountNumber) {
          return json({ error: 'Enter the account name and number.' }, 400);
        }
        const bankName = text(body.bankName, 120) || null;
        const momoNetwork = text(body.momoNetwork, 40) || null;
        if (method === 'bank' && !bankName) {
          return json({ error: 'Enter the bank name.' }, 400);
        }
        if (method === 'momo' && !momoNetwork) {
          return json({ error: 'Choose the Momo network.' }, 400);
        }

        const { error: upsertError } = await admin
          .from('agent_payout_accounts')
          .upsert({
            agent_id: user.id,
            method,
            account_name: accountName,
            account_number: accountNumber,
            bank_name: method === 'bank' ? bankName : null,
            momo_network: method === 'momo' ? momoNetwork : null,
            is_default: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'agent_id' });
        if (upsertError) throw upsertError;
        return json({ success: true });
      }

      if (action === 'request') {
        const amount = round2(Number(body.amount));
        if (!Number.isFinite(amount) || amount <= 0) {
          return json({ error: 'Enter a valid payout amount.' }, 400);
        }
        if (!account) {
          return json({ error: 'Save a payout account before requesting a payout.' }, 400);
        }

        const [{ data: wallet, error: walletError }, { data: openPayouts, error: openError }] = await Promise.all([
          admin.from('wallets').select('commission_balance').eq('id', user.id).maybeSingle(),
          admin.from('agent_payouts')
          .select('amount, status, commission_debited')
          .eq('agent_id', user.id)
          .in('status', RESERVABLE_STATUSES),
        ]);
        if (walletError) throw walletError;
        if (openError) throw openError;

        const committed = (openPayouts ?? [])
          .filter((row) => row.commission_debited !== true)
          .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const commissionBalance = Number(wallet?.commission_balance || 0);
        const available = round2(Math.max(0, commissionBalance - committed));
        if (amount > available) {
          return json({ error: `You can request up to GHS ${available.toFixed(2)}.` }, 400);
        }

        const reference = `PAYOUT-${crypto.randomUUID()}`;
        const { data: payout, error: insertError } = await admin.from('agent_payouts').insert({
          agent_id: user.id,
          amount,
          status: 'requested',
          method: account.method,
          account_snapshot: account,
          reference,
          commission_debited: false,
        }).select('id').single();
        if (insertError) throw insertError;
        const { data: agentRow } = await admin.from('agents').select('agent_code').eq('id', user.id).maybeSingle();
        const { error: transactionError } = await admin.from('transactions').insert({
          agent_id: user.id,
          agent_code: agentRow?.agent_code || null,
          reference,
          amount,
          type: 'Commission Withdrawal',
          description: 'Store commission payout requested; awaiting admin payment',
          status: 'pending',
          metadata: { payout_id: payout?.id || null, commission_debited: false },
          created_at: new Date().toISOString(),
        });
        if (transactionError) {
          if (payout?.id) await admin.from('agent_payouts').delete().eq('id', payout.id);
          throw transactionError;
        }

        // Keep the admin informed without making notification delivery part of
        // the financial request. The payout and transaction are already saved;
        // an unavailable notification row must never make the agent retry and
        // risk creating a duplicate withdrawal request.
        try {
          const { data: admins, error: adminsError } = await admin
            .from('agents')
            .select('id, full_name, role, status, is_active')
            .in('role', ['admin', 'super_admin']);
          if (adminsError) throw adminsError;

          const recipients = (admins || []).filter((row) => (
            (row.status === 'active' || row.id === user.id) && row.is_active !== false
          ));
          if (['admin', 'super_admin'].includes(String(agent?.role)) && !recipients.some((row) => row.id === user.id)) {
            recipients.push({ id: user.id });
          }
          if (recipients.length && payout?.id) {
            const agentName = text(agent?.full_name, 120) || text(agentRow?.agent_code, 80) || 'An agent';
            const notificationRows = recipients.map((recipient) => ({
              user_id: recipient.id,
              title: 'New Store Commission Withdrawal',
              body: `${agentName} requested GHS ${amount.toFixed(2)} from store commission. Review it in Store Commission Payments.`,
              kind: 'warning',
              order_table: 'agent_payouts',
              order_id: payout.id,
            }));
            const { error: notificationError } = await admin
              .from('notifications')
              .insert(notificationRows);
            if (notificationError) throw notificationError;
          }
        } catch (notificationError) {
          console.error('manage-agent-payout notification error:', notificationError);
        }

        return json({ success: true, reference, amount });
      }

      return json({ error: 'Unknown payout action.' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-agent-payout error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process your payout request.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
