import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

function getServiceRoleKey() {
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
  if (legacyKey) return legacyKey;
  const namedKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (namedKeys) {
    const keys = Object.values(JSON.parse(namedKeys));
    if (typeof keys[0] === 'string') return keys[0];
  }
  throw new Error('A Supabase server secret key is not available to this Edge Function.');
}

export const serviceRoleKey = getServiceRoleKey();

export function adminClient() {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

export async function requireAdmin(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Authentication is required.');
  const admin = adminClient();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Your session is invalid.');
  const { data: agent, error: agentError } = await admin
    .from('agents')
    .select('id, role')
    .eq('id', user.id)
    .single();
  if (agentError || agent?.role !== 'admin') throw new Error('Administrator access is required.');
  return { admin, user };
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const corsPreflight = () => new Response('ok', { headers: corsHeaders });

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
