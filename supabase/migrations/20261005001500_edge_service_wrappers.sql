-- =============================================================================
-- PrimeCampus V1 — 1500 Service-role entry points for the `accounts` Edge Function
--
-- The Data API exposes only `public`, so the Edge Function (service_role key) calls
-- these thin public wrappers. They are granted to service_role ONLY — never anon or
-- authenticated — and every one re-checks the requesting user server-side.
-- =============================================================================

-- Requesting user must hold a live app session (TRD §6.1). p_allow_must_change lets
-- a temporary-password user reach change-password and nothing else.
create or replace function private.svc_requester(p_uid uuid, p_auth_session_id uuid, p_allow_must_change boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a app.accounts;
begin
  select * into a from app.accounts where id = p_uid;
  if not found or a.status <> 'active' then perform private.fail('FORBIDDEN', 'Account is not active'); end if;
  if a.must_change_password and not p_allow_must_change then
    perform private.fail('FORBIDDEN', 'Change your temporary password first');
  end if;
  if not exists (select 1 from private.app_sessions where account_id = p_uid
                   and auth_session_id = p_auth_session_id and ended_at is null) then
    perform private.fail('UNAUTHENTICATED', 'Session not active. Sign in again.');
  end if;
  return jsonb_build_object('account_id', a.id, 'username', a.username, 'must_change_password', a.must_change_password,
    'is_operator', exists (select 1 from private.platform_operators where account_id = p_uid and revoked_at is null));
end $$;

-- Operator, or an Admin of EVERY school the target belongs to (TRD §6.3).
-- A target with no memberships can only be managed by an Operator.
create or replace function private.svc_can_manage_account(p_requester uuid, p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_operators where account_id = p_requester and revoked_at is null)
      or (exists (select 1 from app.memberships where account_id = p_target and status = 'active')
          and not exists (select 1 from app.memberships t
                           where t.account_id = p_target and t.status = 'active'
                             and not exists (select 1 from app.memberships r
                                              where r.account_id = p_requester and r.role = 'admin'
                                                and r.status = 'active' and r.school_id = t.school_id))
          and not exists (select 1 from private.platform_operators where account_id = p_target and revoked_at is null))
$$;

-- Step 1 of provisioning: authorise + record intent BEFORE the Auth user exists, so a
-- retry with the same operation_id resumes instead of creating a second identity.
create or replace function private.svc_begin_provisioning(p_operation_id uuid, p_requested_by uuid, p_username text,
                                                          p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_is_op boolean := exists (select 1 from private.platform_operators where account_id = p_requested_by and revoked_at is null);
        m jsonb; r private.provisioning_operations;
begin
  if lower(p_username) !~ '^[a-z0-9][a-z0-9._-]{2,62}$' then
    perform private.fail('VALIDATION_ERROR', 'Username must be 3–63 chars: a-z, 0-9, dot, dash, underscore');
  end if;
  if jsonb_typeof(p_payload->'memberships') <> 'array' or jsonb_array_length(p_payload->'memberships') = 0 then
    perform private.fail('VALIDATION_ERROR', 'At least one school role is required');
  end if;
  for m in select * from jsonb_array_elements(p_payload->'memberships') loop
    if m->>'role' not in ('owner','admin','principal','accountant','teacher','parent','student') then
      perform private.fail('VALIDATION_ERROR', 'Unknown role');
    end if;
    if not v_is_op and not exists (select 1 from app.memberships am
                                    where am.account_id = p_requested_by and am.role = 'admin' and am.status = 'active'
                                      and am.school_id = (m->>'school_id')::uuid) then
      perform private.fail('FORBIDDEN', 'You cannot grant access to that school');
    end if;
  end loop;
  select * into r from private.provisioning_operations where operation_id = p_operation_id;
  if found then
    if r.requested_by <> p_requested_by or r.username <> lower(p_username) then
      perform private.fail('DUPLICATE', 'This operation id belongs to a different request');
    end if;
    return to_jsonb(r);
  end if;
  if exists (select 1 from app.accounts where username = lower(p_username)) then
    perform private.fail('DUPLICATE', 'Username already taken');
  end if;
  insert into private.provisioning_operations (operation_id, requested_by, school_id, username, requested_payload)
  values (p_operation_id, p_requested_by, (p_payload->'memberships'->0->>'school_id')::uuid, lower(p_username), p_payload)
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function private.svc_set_provisioning_auth_user(p_operation_id uuid, p_auth_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.provisioning_operations set auth_user_id = p_auth_user_id, status = 'auth_created', updated_at = now()
   where operation_id = p_operation_id and (auth_user_id is null or auth_user_id = p_auth_user_id)
$$;

create or replace function private.svc_mark_provisioning_failed(p_operation_id uuid, p_error text)
returns void language sql security definer set search_path = '' as $$
  update private.provisioning_operations set status = 'failed', last_error = left(p_error, 500), updated_at = now()
   where operation_id = p_operation_id and status <> 'completed'
$$;

create or replace function private.svc_account_brief(p_account_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', id, 'username', username, 'status', status) from app.accounts where id = p_account_id
$$;

-- ---------------------------------------------------------------- public wrappers (service_role only)
create or replace function public.svc_requester(p_uid uuid, p_auth_session_id uuid, p_allow_must_change boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.svc_requester(p_uid, p_auth_session_id, p_allow_must_change) $$;
create or replace function public.svc_can_manage_account(p_requester uuid, p_target uuid)
returns boolean language sql security invoker set search_path = '' as $$ select private.svc_can_manage_account(p_requester, p_target) $$;
create or replace function public.svc_begin_provisioning(p_operation_id uuid, p_requested_by uuid, p_username text, p_payload jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.svc_begin_provisioning(p_operation_id, p_requested_by, p_username, p_payload) $$;
create or replace function public.svc_set_provisioning_auth_user(p_operation_id uuid, p_auth_user_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.svc_set_provisioning_auth_user(p_operation_id, p_auth_user_id) $$;
create or replace function public.svc_mark_provisioning_failed(p_operation_id uuid, p_error text)
returns void language sql security invoker set search_path = '' as $$ select private.svc_mark_provisioning_failed(p_operation_id, p_error) $$;
create or replace function public.svc_account_brief(p_account_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.svc_account_brief(p_account_id) $$;
create or replace function public.svc_provision_account(p_operation_id uuid, p_requested_by uuid, p_auth_user_id uuid,
                                                        p_username text, p_display_name text, p_memberships jsonb, p_links jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.svc_provision_account(p_operation_id, p_requested_by, p_auth_user_id, p_username, p_display_name, p_memberships, p_links) $$;
create or replace function public.svc_password_changed(p_account_id uuid, p_actor_id uuid, p_was_reset boolean)
returns void language sql security invoker set search_path = '' as $$ select private.svc_password_changed(p_account_id, p_actor_id, p_was_reset) $$;
create or replace function public.svc_set_account_status(p_account_id uuid, p_actor_id uuid, p_active boolean)
returns void language sql security invoker set search_path = '' as $$ select private.svc_set_account_status(p_account_id, p_actor_id, p_active) $$;

-- Lockdown (same rule as 1400): nothing here is callable by browsers.
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
revoke execute on function
  public.svc_requester(uuid, uuid, boolean), public.svc_can_manage_account(uuid, uuid),
  public.svc_begin_provisioning(uuid, uuid, text, jsonb), public.svc_set_provisioning_auth_user(uuid, uuid),
  public.svc_mark_provisioning_failed(uuid, text), public.svc_account_brief(uuid),
  public.svc_provision_account(uuid, uuid, uuid, text, text, jsonb, jsonb),
  public.svc_password_changed(uuid, uuid, boolean), public.svc_set_account_status(uuid, uuid, boolean)
from authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
