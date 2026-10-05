-- =============================================================================
-- PrimeCampus V1 — 1400 Function privilege lockdown
--
-- Postgres gives EXECUTE on every new function to PUBLIC, and per-schema
-- ALTER DEFAULT PRIVILEGES cannot take that away. Supabase additionally grants
-- public-schema functions to anon. So: revoke from PUBLIC/anon everywhere, keeping
-- only the explicit grants made in earlier migrations (authenticated / service_role).
--
-- RULE FOR FUTURE MIGRATIONS: any migration that creates functions must end with
-- these same REVOKE statements (or re-run this file's body), then GRANT explicitly.
-- =============================================================================

revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
revoke execute on all functions in schema app     from public, anon;

-- Edge-only routines: service_role, never browser clients
revoke execute on function
  private.svc_password_changed(uuid, uuid, boolean),
  private.svc_set_account_status(uuid, uuid, boolean),
  private.svc_provision_account(uuid, uuid, uuid, text, text, jsonb, jsonb)
from authenticated;

-- Service role (Edge Functions) may call everything server-side
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
grant execute on all functions in schema app     to service_role;
