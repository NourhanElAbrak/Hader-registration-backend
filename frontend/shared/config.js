// Addresses the frontend talks to. Nothing secret here:
// the publishable key is designed to be public (tables are protected by RLS).
const CONFIG = {
  // Each service's API. Locally each runs on its own port; in AWS they become API Gateway addresses.
  REGISTRATION_API: 'http://localhost:3001',

  // Supabase Auth (login and sign-up)
  SUPABASE_URL: 'https://lydhdtlxodhyqjhvcfdu.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_RwEDDrJWI8dfQLh1k54qoQ_XduP2Bjv'
};
