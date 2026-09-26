import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import { submitAfaRegistration } from '../_shared/afaProvider.ts';

const VALID_STATUSES = ['Pending', 'Processing', 'Completed', 'Cancelled'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const AFA_SELECT = 'reference, full_name, phone, town, id_type, id_number, date_of_birth, occupation, price_id, amount, status, source, created_at, provider_reference, failure_reason';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const query = (url.searchParams.get('query') || '').trim().toLowerCase();

      let supabaseQuery = admin
        .from('afa_registrations')
        .select(AFA_SELECT)
        .order('created_at', { ascending: false })
        .limit(200);

      if (query) {
        supabaseQuery = supabaseQuery.or(`phone.ilike.${query},id_number.ilike.${query},full_name.ilike.${query},reference.ilike.${query},town.ilike.${query}`);
      }

      const { data, error } = await supabaseQuery;
      if (error) throw error;
      return json({ registrations: data || [] });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const action = body.action;

      if (action === 'create') {
        const fullName = String(body.fullName || '').trim();
        const phone = String(body.phone || '').trim();
        const town = String(body.town || '').trim();
        const idNumber = String(body.idNumber || '').trim();
        const dateOfBirth = String(body.dateOfBirth || '').trim();
        const occupation = String(body.occupation || '').trim();
        const priceId = String(body.priceId || '').trim();
        const amountVal = Number(body.amount);
        const feeAmount = Number.isFinite(amountVal) && amountVal > 0
          ? Math.round(amountVal * 100) / 100
          : Number(Deno.env.get('AFA_FEE_AMOUNT') ?? '8');

        if (!fullName || !phone || !town || !idNumber || !occupation) {
          return json({ error: 'All registration fields are required.' }, 400);
        }
        if (!ISO_DATE.test(dateOfBirth) || Number.isNaN(new Date(dateOfBirth).getTime())) {
          return json({ error: 'A valid date of birth (YYYY-MM-DD) is required.' }, 400);
        }

        const reference = `AFA-${crypto.randomUUID()}`;
        const walletBalance = await chargeWallet(user.id, reference, feeAmount, 'AFA Registration Fee', {
          service: 'afa_registration', id_number: idNumber,
        });

        const { data: registration, error } = await admin
          .from('afa_registrations')
          .insert({
            reference,
            full_name: fullName,
            phone,
            town,
            id_type: 'Ghana Card',
            id_number: idNumber,
            date_of_birth: dateOfBirth,
            occupation,
            price_id: priceId || null,
            amount: feeAmount,
            status: 'Pending',
            source: 'agent',
            created_by: user.id,
          })
          .select(AFA_SELECT)
          .single();
        if (error) throw error;

        const submitResult = await submitAfaRegistration({
          fullName,
          phoneNumber: phone,
          town,
          occupation,
          priceId,
          idNumber,
          idType: 'Ghana Card',
          dateOfBirth,
          reference,
        });

        if (!submitResult.success) {
          await admin
            .from('afa_registrations')
            .update({
              status: 'Cancelled',
              failure_reason: submitResult.failureReason,
              provider_response: submitResult.providerResponse ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', registration.id);
          const refundedBalance = await refundWallet(user.id, reference, feeAmount, 'AFA registration rejected by provider');
          return json({
            success: false,
            refunded: true,
            walletBalance: refundedBalance,
            registration: { ...registration, status: 'Cancelled' },
            message: `AFA registration was not accepted: ${submitResult.failureReason || 'Provider declined.'} Your wallet has been refunded.`,
          }, 502);
        }

        const { data: updated } = await admin
          .from('afa_registrations')
          .update({
            status: 'Processing',
            provider_reference: submitResult.providerReference ?? null,
            provider_response: submitResult.providerResponse ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', registration.id)
          .select(AFA_SELECT)
          .single();

        return json({
          success: true,
          walletBalance,
          registration: updated ?? registration,
        }, 201);
      }

      if (action === 'update_status') {
        const reference = String(body.reference || '').trim();
        const status = String(body.status || '').trim();
        if (!reference || !VALID_STATUSES.includes(status)) {
          return json({ error: 'A valid reference and status are required.' }, 400);
        }

        const { data, error: updateError } = await admin
          .from('afa_registrations')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('reference', reference)
          .select(AFA_SELECT)
          .single();

        if (updateError) throw updateError;
        return json({ registration: data });
      }

      return json({ error: 'Unknown action.' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-afa-registrations error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process AFA request.';
    const status = message.includes('Authentication') ? 401 : message.toLowerCase().includes('insufficient') ? 400 : 500;
    return json({ error: message }, status);
  }
});