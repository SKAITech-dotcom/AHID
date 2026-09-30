# Utility provider connection

The utility page now calls a server-side provider adapter. It no longer invents customer names or ECG tokens. Configure the provider endpoint and API key as Supabase Edge Function secrets before enabling utility payments:

```sh
supabase secrets set UTILITY_PROVIDER_API_URL="https://provider.example/api/utility" UTILITY_PROVIDER_API_KEY="replace-with-provider-key"
```

The configured endpoint must accept authenticated `POST` requests with JSON. Requests contain `action` (`verify`, `purchase`, or `status`) plus service/account/order details. The adapter expects:

- `verify`: `{ "success": true, "verified": true, "customerName": "..." }`
- `purchase`: `{ "success": true, "token": "...", "providerReference": "..." }` (`token` is required for ECG Prepaid)
- `status`: `{ "success": true, "status": "completed" | "failed", "token": "..." }`

Every purchase request includes the unique Skaitech reference so the provider can make retries idempotent. The page requires verified agent access, verifies the account on the server before charging, records utility orders, and charges the wallet using the 1.5% processing fee shown in the review step. A declined purchase refunds the wallet; an ambiguous provider timeout stays in `processing` so it can be reconciled without risking a duplicate utility purchase.

Deploy the `verify-utility-account`, `create-utility-bill-payment`, and `get-utility-bill-order` Edge Functions, then apply the `20260930110000_ecg_postpaid.sql` migration before using ECG Postpaid. The Paystack webhook also uses the adapter for any existing gateway-paid utility orders.
