import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://eoexqzxrdegyazglpzrv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_t8NIXquR2txP16eigi37Jw_GszCNStY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // Electron runs on file:// — don't try to parse OAuth tokens from the URL
  },
});
