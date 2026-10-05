-- =============================================================================
-- PrimeCampus V1 — 1600 Operator helpers found missing during M0 planning
--  * op_list_schools            Operator needs a school picker (bootstrap only lists memberships)
--  * op_find_account            Operator looks up an account id by username (support, e2e reset)
--  * op_create_school           duplicate org/school code now returns DUPLICATE instead of a raw error
-- =============================================================================

create or replace function private.op_list_schools()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_operator();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'school_id', s.id, 'name', s.name, 'code', s.code, 'status', s.status,
      'organization_id', o.id, 'organization_name', o.name, 'organization_code', o.code,
      'created_at', s.created_at) order by o.name, s.name)
    from app.schools s join app.organizations o on o.id = s.organization_id), '[]'::jsonb);
end $$;

create or replace function private.op_find_account(p_username text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_operator();
  return (select jsonb_build_object('account_id', a.id, 'username', a.username, 'display_name', a.display_name,
                                    'status', a.status, 'must_change_password', a.must_change_password,
                                    'memberships', coalesce((select jsonb_agg(jsonb_build_object(
                                        'membership_id', m.id, 'school_id', m.school_id, 'role', m.role, 'status', m.status))
                                      from app.memberships m where m.account_id = a.id), '[]'::jsonb))
            from app.accounts a where a.username = lower(btrim(p_username)));
end $$;

create or replace function private.op_create_school(p_organization jsonb, p_school jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_school uuid;
begin
  perform private.require_operator();
  if p_organization ? 'id' then
    v_org := (p_organization->>'id')::uuid;
    if not exists (select 1 from app.organizations where id = v_org) then
      perform private.fail('NOT_FOUND', 'Organization not found');
    end if;
  else
    if exists (select 1 from app.organizations where code = p_organization->>'code') then
      perform private.fail('DUPLICATE', 'Organization code already exists');
    end if;
    insert into app.organizations (name, code) values (p_organization->>'name', p_organization->>'code') returning id into v_org;
  end if;
  if exists (select 1 from app.schools where code = p_school->>'code') then
    perform private.fail('DUPLICATE', 'School code already exists');
  end if;
  begin
    insert into app.schools (organization_id, name, code, udise_code, board, phone, email, address_line, city, district, pincode)
    values (v_org, p_school->>'name', p_school->>'code', p_school->>'udise_code', p_school->>'board', p_school->>'phone',
            p_school->>'email', p_school->>'address_line', p_school->>'city', p_school->>'district', p_school->>'pincode')
    returning id into v_school;
  exception when check_violation or not_null_violation then
    perform private.fail('VALIDATION_ERROR', 'Check the school details (code: 2–12 lowercase letters/digits; pincode 6 digits; UDISE 11 digits)');
  end;
  perform private.log_event('operator.school_created', 'schools', v_school::text, p_school);
  return jsonb_build_object('organization_id', v_org, 'school_id', v_school);
end $$;

create or replace function public.op_list_schools()
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_list_schools() $$;
create or replace function public.op_find_account(p_username text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_find_account(p_username) $$;

revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.op_list_schools(), private.op_find_account(text), private.op_create_school(jsonb, jsonb) to authenticated;
grant execute on function public.op_list_schools(), public.op_find_account(text) to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
