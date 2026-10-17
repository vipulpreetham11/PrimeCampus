-- =============================================================================
-- PrimeCampus V1 — 1900 Gaps found by the M1 planning review
--  * get_context            capabilities now include 'staff.member' (several RPCs check it)
--  * get_school_profile     read for the version-checked school profile form
--  * get_setup_snapshot     sections carry capacity / sort_order / academic_year_id;
--                           attendance_modes lists today's and future mode changes
--  * get_staff              full non-confidential staff record (+ linked login for users.manage)
--  * get_guardian           full guardian record with version + children
--  * search_guardians, get_student_profile   guardian rows carry version; profile shows linked login
--  * list_leads             keyset paging on (created_at, id); returns {items, next_cursor}
-- =============================================================================

create or replace function private.get_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_school text; v_year jsonb;
begin
  select * into c from private.require_ctx(null);
  select name into v_school from app.schools where id = c.school_id;
  select jsonb_build_object('id', id, 'name', name, 'start_date', start_date, 'end_date', end_date)
    into v_year from app.academic_years where school_id = c.school_id and is_current;
  return jsonb_build_object(
    'school_id', c.school_id, 'school_name', v_school, 'role', c.role, 'via_operator', c.via_operator,
    'student_id', c.student_id, 'staff_id', c.staff_id, 'context_revision', c.context_revision,
    'current_year', v_year,
    'capabilities', (select jsonb_agg(cap) from unnest(array[
        'staff.member',
        'setup.manage','users.manage','students.read_all','students.manage','students.sensitive','admissions.manage',
        'imports.manage','timetable.read_all','timetable.manage','attendance.read_all','attendance.mark_any',
        'attendance.summary','academic.read_all','academic.correct','fees.read','fees.manage','staff.read',
        'staff.manage','staff_attendance.read','staff_attendance.manage','staff_finance.read',
        'staff_finance.manage','export.full','audit.read']) cap
        where private.role_has_cap(c.role, cap) or (cap = 'admissions.manage' and c.admissions_duty)));
end $$;

create or replace function public.get_school_profile(p_ctx_rev integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  select jsonb_build_object('school_id', s.id, 'name', s.name, 'code', s.code, 'udise_code', s.udise_code,
           'board', s.board, 'affiliation_no', s.affiliation_no, 'phone', s.phone, 'email', s.email,
           'address_line', s.address_line, 'city', s.city, 'district', s.district, 'state', s.state,
           'pincode', s.pincode, 'logo_url', s.logo_url, 'timezone', s.timezone, 'status', s.status,
           'version', s.version,
           'can_edit', private.has_cap('setup.manage'))
    into v from app.schools s where s.id = c.school_id;
  if v is null then perform private.fail('NOT_FOUND', 'School not found'); end if;
  return v;
end $$;

create or replace function public.get_setup_snapshot(p_ctx_rev integer, p_academic_year_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_year uuid; v_today date;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  v_year := coalesce(p_academic_year_id, (select id from app.academic_years where school_id = c.school_id and is_current));
  v_today := private.school_today(c.school_id);
  return jsonb_build_object(
    'academic_years', (select coalesce(jsonb_agg(to_jsonb(y) - 'school_id' order by y.start_date desc), '[]') from app.academic_years y where y.school_id = c.school_id),
    'selected_year_id', v_year,
    'classes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'sort_order', sort_order, 'status', status, 'version', version) order by sort_order), '[]')
                  from app.classes where school_id = c.school_id),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'academic_year_id', s.academic_year_id, 'class_id', s.class_id,
                     'name', s.name, 'capacity', s.capacity, 'sort_order', s.sort_order, 'status', s.status, 'version', s.version)
                   order by s.sort_order, s.name), '[]') from app.sections s where s.school_id = c.school_id and s.academic_year_id = v_year),
    'subjects', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'status', status, 'version', version) order by name), '[]')
                   from app.subjects where school_id = c.school_id),
    'period_schedules', (select coalesce(jsonb_agg(jsonb_build_object('id', ps.id, 'name', ps.name, 'kind', ps.kind,
                            'effective_from', ps.effective_from, 'effective_to', ps.effective_to,
                            'slots', (select jsonb_agg(jsonb_build_object('ordinal', ordinal, 'label', label, 'kind', kind,
                                                       'start_time', start_time, 'end_time', end_time) order by ordinal)
                                        from app.schedule_slots where period_schedule_id = ps.id))
                          order by ps.effective_from desc), '[]') from app.period_schedules ps where ps.school_id = c.school_id and ps.status = 'active'),
    'attendance_mode_today', private.attendance_mode_on(c.school_id, v_today),
    -- the mode in force today plus every scheduled change after today (empty for roles without staff.member)
    'attendance_modes', (select coalesce(jsonb_agg(jsonb_build_object('mode', m.mode, 'effective_from', m.effective_from)
                            order by m.effective_from), '[]')
                           from app.attendance_modes m
                          where m.school_id = c.school_id
                            and (m.effective_from > v_today
                                 or m.effective_from = (select max(x.effective_from) from app.attendance_modes x
                                                         where x.school_id = c.school_id and x.effective_from <= v_today))));
end $$;

create or replace function public.get_staff(p_ctx_rev integer, p_staff_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v jsonb; v_acc uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff.read');
  select jsonb_build_object('staff_id', s.id, 'employee_no', s.employee_no, 'full_name', s.full_name, 'gender', s.gender,
           'phone', s.phone, 'email', s.email, 'staff_group_id', s.staff_group_id, 'group', g.name,
           'designation', s.designation, 'is_teaching', s.is_teaching, 'joined_on', s.joined_on, 'left_on', s.left_on,
           'status', s.status, 'has_login', s.account_id is not null, 'version', s.version), s.account_id
    into v, v_acc
    from app.staff s join app.staff_groups g on g.id = s.staff_group_id
   where s.id = p_staff_id and s.school_id = c.school_id;
  if v is null then perform private.fail('NOT_FOUND', 'Staff record not found'); end if;
  return v || jsonb_build_object(
    'login', case when private.has_cap('users.manage') and v_acc is not null then
               (select jsonb_build_object('account_id', a.id, 'username', a.username, 'status', a.status)
                  from app.accounts a where a.id = v_acc) end,
    'can', jsonb_build_object('edit', private.has_cap('staff.manage'), 'finance', private.has_cap('staff_finance.read'),
                              'link_login', private.has_cap('users.manage')));
end $$;

create or replace function public.get_guardian(p_ctx_rev integer, p_guardian_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v jsonb; v_acc uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  select jsonb_build_object('guardian_id', g.id, 'full_name', g.full_name, 'phone', g.phone, 'alt_phone', g.alt_phone,
           'email', g.email, 'occupation', g.occupation, 'address_line', g.address_line, 'status', g.status,
           'has_login', g.account_id is not null, 'version', g.version), g.account_id
    into v, v_acc
    from app.guardians g where g.id = p_guardian_id and g.school_id = c.school_id;     -- RLS limits the row
  if v is null then perform private.fail('NOT_FOUND', 'Guardian not found'); end if;
  return v || jsonb_build_object(
    'children', coalesce((select jsonb_agg(jsonb_build_object('student_id', s.id, 'name', s.full_name,
                    'admission_no', s.admission_no, 'relationship', sg.relationship, 'is_primary', sg.is_primary,
                    'portal_access', sg.portal_access) order by s.full_name)
                  from app.student_guardians sg join app.students s on s.id = sg.student_id
                 where sg.guardian_id = p_guardian_id), '[]'::jsonb),
    'login', case when private.has_cap('users.manage') and v_acc is not null then
               (select jsonb_build_object('account_id', a.id, 'username', a.username, 'status', a.status)
                  from app.accounts a where a.id = v_acc) end,
    'can', jsonb_build_object('edit', private.has_cap('students.manage'), 'link_login', private.has_cap('users.manage')));
end $$;

create or replace function public.search_guardians(p_ctx_rev integer, p_query text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; q text := btrim(coalesce(p_query, ''));
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('students.manage');
  if length(q) < 3 then perform private.fail('VALIDATION_ERROR', 'Type at least 3 characters or a phone number'); end if;
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('guardian_id', g.id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email,
             'has_login', g.account_id is not null, 'status', g.status, 'version', g.version,
             'children', coalesce((select jsonb_agg(jsonb_build_object('student_id', s.id, 'name', s.full_name,
                            'admission_no', s.admission_no, 'relationship', sg.relationship))
                          from app.student_guardians sg join app.students s on s.id = sg.student_id
                         where sg.guardian_id = g.id), '[]'::jsonb)) as x
      from app.guardians g
     where g.school_id = c.school_id
       and (g.phone = regexp_replace(q, '\D', '', 'g') or g.alt_phone = regexp_replace(q, '\D', '', 'g')
            or lower(g.full_name) like lower(q) || '%' or lower(g.full_name) like '% ' || lower(q) || '%')
     order by g.full_name limit 20) t), '[]'::jsonb);
end $$;

create or replace function public.get_student_profile(p_ctx_rev integer, p_student_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_s jsonb; v_acc uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  select to_jsonb(s) - 'school_id' - 'account_id' - 'created_by' - 'updated_by', s.account_id into v_s, v_acc
    from app.students s where s.id = p_student_id and s.school_id = c.school_id;     -- RLS limits the row
  if v_s is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  return jsonb_build_object(
    'profile', v_s,
    'age_today', extract(year from age(private.school_today(c.school_id), (v_s->>'date_of_birth')::date)),
    'guardians', (select coalesce(jsonb_agg(jsonb_build_object('guardian_id', g.id, 'name', g.full_name, 'phone', g.phone,
                     'email', g.email, 'occupation', g.occupation, 'relationship', sg.relationship,
                     'is_primary', sg.is_primary, 'portal_access', sg.portal_access, 'has_login', g.account_id is not null,
                     'version', g.version)), '[]')
                    from app.student_guardians sg join app.guardians g on g.id = sg.guardian_id where sg.student_id = p_student_id),
    'placements', (select coalesce(jsonb_agg(jsonb_build_object('section_id', p.section_id, 'class', cl.name, 'section', sec.name,
                      'roll_no', p.roll_no, 'from', p.effective_from, 'to', p.effective_to, 'reason', p.reason,
                      'year', ay.name) order by p.effective_from desc), '[]')
                     from app.placements p join app.sections sec on sec.id = p.section_id
                     join app.classes cl on cl.id = sec.class_id join app.academic_years ay on ay.id = p.academic_year_id
                    where p.student_id = p_student_id),
    'sensitive', case when private.has_cap('students.sensitive')
                      then (select to_jsonb(ss) - 'school_id' - 'student_id' from app.student_sensitive ss where ss.student_id = p_student_id) end,
    'login', case when private.has_cap('users.manage') and v_acc is not null then
               (select jsonb_build_object('account_id', a.id, 'username', a.username, 'status', a.status)
                  from app.accounts a where a.id = v_acc) end,
    'can', jsonb_build_object('edit', private.has_cap('students.manage'), 'fees', private.has_cap('fees.read'),
                              'attendance', private.has_cap('attendance.read_all') or c.role in ('teacher','parent','student'),
                              'link_login', private.has_cap('users.manage')));
end $$;

drop function if exists public.list_leads(integer, text, text, timestamptz, integer);
create or replace function public.list_leads(p_ctx_rev integer, p_stage text default null, p_search text default null,
                                             p_before_created_at timestamptz default null, p_before_id uuid default null,
                                             p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_items jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('admissions.manage');
  if (p_before_created_at is null) <> (p_before_id is null) then
    perform private.fail('VALIDATION_ERROR', 'Pass both p_before_created_at and p_before_id, or neither');
  end if;
  select coalesce(jsonb_agg(to_jsonb(l) - 'school_id' order by l.created_at desc, l.id desc), '[]') into v_items from (
    select * from app.leads
     where school_id = c.school_id and (p_stage is null or stage = p_stage)
       and (p_search is null or phone = p_search or lower(parent_name) like lower(p_search) || '%'
            or lower(coalesce(child_name, '')) like lower(p_search) || '%')
       and (p_before_created_at is null or (created_at, id) < (p_before_created_at, p_before_id))
     order by created_at desc, id desc limit v_limit) l;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_created_at', v_items->-1->>'created_at', 'before_id', v_items->-1->>'id') end);
end $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  public.get_school_profile(integer), public.get_setup_snapshot(integer, uuid), public.get_staff(integer, uuid),
  public.get_guardian(integer, uuid), public.search_guardians(integer, text), public.get_student_profile(integer, uuid),
  public.list_leads(integer, text, text, timestamptz, uuid, integer)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
