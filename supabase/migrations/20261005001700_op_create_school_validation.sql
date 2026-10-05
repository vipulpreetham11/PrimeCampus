-- =============================================================================
-- PrimeCampus V1 — 1700 op_create_school: bad organization input returns
-- VALIDATION_ERROR (not a raw constraint error). Found during M0 review.
-- =============================================================================
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
    begin
      insert into app.organizations (name, code) values (p_organization->>'name', p_organization->>'code') returning id into v_org;
    exception when check_violation or not_null_violation then
      perform private.fail('VALIDATION_ERROR', 'Check the organization details (code: 2–40 lowercase letters, digits or dashes; name required)');
    end;
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

revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.op_create_school(jsonb, jsonb) to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
