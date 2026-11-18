-- The QR analytics migration is already live; explicitly grant the table
-- privileges required for its RLS insert/select policies.
grant insert on public.qr_scans to anon, authenticated;
grant select on public.qr_scans to authenticated;
