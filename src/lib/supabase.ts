import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/generated/database.types';
import { env } from './env';

// The single browser client. Publishable key only — never a secret/service key (CLAUDE.md).
// Only the Auth SDK's own session persistence is used; school data is never stored in the browser.
export const supabase = createClient<Database>(env.supabaseUrl, env.supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'primecampus-auth',
  },
});

export type SupabaseClient = typeof supabase;
