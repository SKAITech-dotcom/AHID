# Secure results-checker deployment

This implementation assumes `agents.id` and `results_orders.id` are UUIDs. It adds
`agents.role` and the protected `result_checker_pins` stock table. Apply the SQL
migration before deploying any function.

## 1. Prepare Supabase

Run both migrations in `supabase/migrations/` in the Supabase SQL editor. Then
promote your own authenticated agent account to an administrator:

```sql
update public.agents set role = 'admin' where agent_code = 'YOUR-AGENT-CODE';
```

The `agents.id` value must be the same UUID as the user's Supabase Auth user ID.

## 2. Set secrets and deploy

For agent registration during testing, enable **Allow new users to sign up** in
Supabase Dashboard under **Authentication > Settings**. Keep email confirmation
disabled only for testing; enable it and configure SMTP before production.

Install and log into the Supabase CLI, link this project, then set secrets. Do not
place the Paystack secret key in frontend JavaScript or commit it to Git.

```powershell
supabase secrets set PAYSTACK_SECRET_KEY=
supabase secrets set DATA_API_KEY=
supabase secrets set SITE_URL=https://your-domain.example
supabase secrets set PUBLIC_DATA_AGENT_ID=YOUR_COMPANY_AGENT_AUTH_UUID
supabase functions deploy create-result-checker-payment --no-verify-jwt
supabase functions deploy get-result-checker-order --no-verify-jwt
supabase functions deploy paystack-webhook --no-verify-jwt
supabase functions deploy create-agent-wallet-payment
supabase functions deploy purchase-agent-data
supabase functions deploy create-public-data-payment --no-verify-jwt
supabase functions deploy get-public-data-order --no-verify-jwt
supabase functions deploy upload-result-checker-pins
supabase functions deploy result-checker-stock
```

In Paystack Dashboard, set the webhook URL to:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/paystack-webhook
```

Use Paystack **test mode** first. The webhook signature and a second Paystack API
verification both have to succeed before a PIN is assigned.

For wallet testing, `PAYSTACK_SECRET_KEY` and the Paystack dashboard must use the
same mode: use `sk_test_...` with test mode or `sk_live_...` with live mode. Set
`SITE_URL` to the real address where `deposit.html` is hosted; do not leave the
placeholder domain or use an unreachable local-only URL for a deployed checkout.

## 3. Test checklist

1. Sign in as the promoted admin and open `adminResultPins.html`.
2. Upload one or more test PINs, for example `1234-5678-9012,SERIAL-001`.
3. Confirm the available stock count appears.
4. Open `resultsChecker.html` in another browser/private window, purchase one PIN
   with a Paystack test payment method, and complete checkout.
5. Check `results_orders`: its status must become `paid`, with the same Paystack
   reference and assigned PIN data.
6. Confirm the matching `result_checker_pins` row changed from `available` to
   `sold`, and repeat with two concurrent test checkouts to ensure no PIN repeats.
7. Test a declined or abandoned payment: its order must remain `pending_payment`
   and no PIN must be marked sold.

## Before production

Set live Paystack keys and a production `SITE_URL`, ensure HTTPS is enabled, and
configure Paystack's live webhook. Add rate limiting/CAPTCHA to the public payment
function and a secure customer receipt/retrieval flow if PINs must be available on
another device after checkout.
