// Public build-time configuration. Every VITE_ value is visible in the bundle (TRD §20).
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env.local.`);
  return value;
}

export const env = {
  supabaseUrl: required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL),
  supabasePublishableKey: required(
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  ),
  loginEmailDomain: required('VITE_LOGIN_EMAIL_DOMAIN', import.meta.env.VITE_LOGIN_EMAIL_DOMAIN),
} as const;
