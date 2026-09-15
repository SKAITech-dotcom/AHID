import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://mxovqblxizvjsmudjsjf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bTpLJRZs057-DFMMeaz3Xw_oSdrYKy9';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
