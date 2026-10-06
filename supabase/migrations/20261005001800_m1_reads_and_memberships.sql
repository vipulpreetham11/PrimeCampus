-- =============================================================================
-- PrimeCampus V1 — 1800 Backend for module M1 (Setup & People), found missing while
-- writing the M1 brief: reads the setup screens need, and membership management for
-- existing accounts (multi-role users, AC-02) plus linking logins to staff/guardian/student.
--
-- Reads are SECURITY INVOKER (RLS enforces scope). Writes that touch memberships or
-- account links are SECURITY DEFINER with explicit context + capability checks.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Calendar read (definer: resolves days with private.resolve_day for this school only)
-- -----------------------------------------------------------------------------
create or replace function private.get_calendar(p_rev integer, p_academic_year_id uuid, p_audience text,
                                                p_staff_group_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; y app.academic_years; v_from date; v_to date;
begin
  select * into c from private.require_ctx(p_rev);
  if p_audience not in ('student','staff') then perform private.fail('VALIDATION_ERROR', 'audience must be student or staff'); end if;
  if p_audience = 'staff' then perform private.require_cap('staff.member'); end if;
  if p_audience = 'student' and p_staff_group_id is not null then
    perform private.fail('VALIDATION_ERROR', 'Staff groups apply only to the staff calendar');
  end if;
  select * into y from app.academic_years where id = p_academic_year_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Academic year not found'); end if;
  if p_staff_group_id is not null and not exists (select 1 from app.staff_groups where id = p_staff_group_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Staff group not found');
  end if;
  v_from := greatest(coalesce(p_from, y.start_date), y.start_date);
  v_to   := least(coalesce(p_to, y.end_date), y.end_date);
  if v_to - v_from > 400 then perform private.fail('LIMIT_REACHED', 'Range too long'); end if;
  return jsonb_build_object(
    'academic_year', jsonb_build_object('id', y.id, 'name', y.name, 'start_date', y.start_date, 'end_date', y.end_date),
    'audience', p_audience, 'staff_group_id', p_staff_group_id,
    'patterns', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'weekday', weekday, 'day_type', day_type,
                    'period_schedule_id', period_schedule_id, 'staff_group_id', staff_group_id, 'version', version)
                    order by staff_group_id nulls first, weekday)
                  from app.calendar_patterns
                 where academic_year_id = y.id and audience = p_audience
                   and (staff_group_id is null or staff_group_id = p_staff_group_id)), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'date', cal_date, 'day_type', day_type,
                    'period_schedule_id', period_schedule_id, 'label', label, 'reason', reason,
                    'is_exam_day', is_exam_day, 'staff_group_id', staff_group_id, 'version', version) order by cal_date)
                  from app.calendar_days
                 where school_id = c.school_id and academic_year_id = y.id and audience = p_audience
                   and (staff_group_id is null or staff_group_id = p_staff_group_id)
                   and cal_date between v_from and v_to), '[]'::jsonb),
    'resolved', coalesce((select jsonb_agg(jsonb_build_object('date', d::date, 'day_type', r.day_type, 'weight', r.weight,
                    'period_schedule_id', r.period_schedule_id, 'label', r.label) order by d)
                  from generate_series(v_from, v_to, interval '1 day') d
                  cross join lateral private.resolve_day(c.school_id, p_audience, p_staff_group_id, d::date) r), '[]'::jsonb),
    'totals', (select jsonb_build_object(
                  'working_days', count(*) filter (where r.day_type = 'working'),
                  'half_days', count(*) filter (where r.day_type = 'half_day'),
                  'holidays', count(*) filter (where r.day_type = 'holiday'),
                  'weekly_offs', count(*) filter (where r.day_type = 'weekly_off'),
                  'working_weight', coalesce(sum(r.weight), 0))
                from generate_series(v_from, v_to, interval '1 day') d
                cross join lateral private.resolve_day(c.school_id, p_audience, p_staff_group_id, d::date) r));
end $$;

-- -----------------------------------------------------------------------------
-- Simple invoker reads (RLS decides what each role sees)
-- -----------------------------------------------------------------------------
create or replace function public.list_staff_groups(p_ctx_rev integer, p_include_retired boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff.member');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', g.id, 'name', g.name, 'status', g.status, 'version', g.version,
      'staff_count', (select count(*) from app.staff s where s.staff_group_id = g.id and s.status = 'active'),
      -- null unless the caller may read staff finance (RLS on the defaults table)
      'default_monthly_salary_paise', (select d.monthly_salary_paise from app.staff_group_salary_defaults d where d.staff_group_id = g.id))
      order by g.name)
    from app.staff_groups g
   where g.school_id = c.school_id and (p_include_retired or g.status = 'active')), '[]'::jsonb);
end $$;

create or replace function public.list_class_subjects(p_ctx_rev integer, p_academic_year_id uuid, p_class_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', cs.id, 'class_id', cs.class_id, 'subject_id', cs.subject_id, 'subject', s.name, 'code', s.code,
      'is_optional', cs.is_optional, 'sort_order', cs.sort_order, 'status', cs.status) order by cs.class_id, cs.sort_order, s.name)
    from app.class_subjects cs join app.subjects s on s.id = cs.subject_id
   where cs.school_id = c.school_id and cs.academic_year_id = p_academic_year_id
     and (p_class_id is null or cs.class_id = p_class_id) and cs.status = 'active'), '[]'::jsonb);
end $$;

create or replace function public.list_teaching_assignments(p_ctx_rev integer, p_academic_year_id uuid default null,
                                                            p_section_id uuid default null, p_staff_id uuid default null,
                                                            p_active_on date default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff.member');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', ta.id, 'academic_year_id', ta.academic_year_id, 'section_id', ta.section_id,
      'section', cl.name || ' ' || sec.name, 'staff_id', ta.staff_id, 'staff', st.full_name,
      'kind', ta.kind, 'subject_id', ta.subject_id, 'subject', sub.name,
      'effective_from', ta.effective_from, 'effective_to', ta.effective_to) order by cl.sort_order, sec.name, ta.kind, sub.name)
    from app.teaching_assignments ta
    join app.sections sec on sec.id = ta.section_id
    join app.classes cl on cl.id = sec.class_id
    join app.staff st on st.id = ta.staff_id
    left join app.subjects sub on sub.id = ta.subject_id
   where ta.school_id = c.school_id
     and (p_academic_year_id is null or ta.academic_year_id = p_academic_year_id)
     and (p_section_id is null or ta.section_id = p_section_id)
     and (p_staff_id is null or ta.staff_id = p_staff_id)
     and (p_active_on is null or (ta.effective_from <= p_active_on and (ta.effective_to is null or ta.effective_to > p_active_on)))), '[]'::jsonb);
end $$;

create or replace function public.get_lead(p_ctx_rev integer, p_lead_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('admissions.manage');
  select to_jsonb(l) - 'school_id' into v from app.leads l where l.id = p_lead_id and l.school_id = c.school_id;
  if v is null then perform private.fail('NOT_FOUND', 'Enquiry not found'); end if;
  return jsonb_build_object('lead', v,
    'followups', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'contacted_at', f.contacted_at, 'channel', f.channel,
                     'outcome', f.outcome, 'note', f.note, 'next_follow_up_on', f.next_follow_up_on,
                     'by', a.display_name) order by f.contacted_at desc)
                   from app.lead_followups f left join app.accounts a on a.id = f.created_by
                  where f.lead_id = p_lead_id), '[]'::jsonb),
    'same_phone', coalesce((select jsonb_agg(jsonb_build_object('lead_id', o.id, 'parent_name', o.parent_name,
                     'child_name', o.child_name, 'stage', o.stage))
                   from app.leads o where o.school_id = c.school_id and o.id <> p_lead_id and o.phone = v->>'phone'), '[]'::jsonb));
end $$;

-- Find existing guardians to link a sibling instead of creating a duplicate person
create or replace function public.search_guardians(p_ctx_rev integer, p_query text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; q text := btrim(coalesce(p_query, ''));
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('students.manage');
  if length(q) < 3 then perform private.fail('VALIDATION_ERROR', 'Type at least 3 characters or a phone number'); end if;
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('guardian_id', g.id, 'full_name', g.full_name, 'phone', g.phone, 'email', g.email,
             'has_login', g.account_id is not null, 'status', g.status,
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

-- School user directory: every account with a membership here, its roles and linked records
create or replace function public.list_school_users(p_ctx_rev integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('users.manage');
  return coalesce((select jsonb_agg(u order by u->>'display_name') from (
    select jsonb_build_object(
      'account_id', a.id, 'username', a.username, 'display_name', a.display_name, 'status', a.status,
      'must_change_password', a.must_change_password, 'last_seen_at', a.last_seen_at,
      'memberships', (select jsonb_agg(jsonb_build_object('membership_id', m.id, 'role', m.role, 'status', m.status,
                         'admissions_duty', m.admissions_duty, 'version', m.version) order by m.role)
                       from app.memberships m where m.account_id = a.id and m.school_id = c.school_id),
      'staff', (select jsonb_build_object('staff_id', s.id, 'name', s.full_name, 'employee_no', s.employee_no)
                  from app.staff s where s.account_id = a.id and s.school_id = c.school_id),
      'guardian', (select jsonb_build_object('guardian_id', g.id, 'name', g.full_name)
                     from app.guardians g where g.account_id = a.id and g.school_id = c.school_id limit 1),
      'student', (select jsonb_build_object('student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no)
                    from app.students st where st.account_id = a.id and st.school_id = c.school_id)) as u
    from app.accounts a
   where exists (select 1 from app.memberships m where m.account_id = a.id and m.school_id = c.school_id)) t), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Membership management for EXISTING accounts (definer)
-- An Admin may only add roles to accounts already belonging to a school of the same
-- organization (TRD §6.2: cross-organization linking is Operator-mediated).
-- -----------------------------------------------------------------------------
create or replace function private.find_school_account(p_rev integer, p_username text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_org uuid; a app.accounts;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('users.manage');
  select organization_id into v_org from app.schools where id = c.school_id;
  select * into a from app.accounts where username = lower(btrim(p_username));
  if not found or not (c.via_operator or exists (
        select 1 from app.memberships m join app.schools s on s.id = m.school_id
         where m.account_id = a.id and s.organization_id = v_org)) then
    -- same answer for "doesn't exist" and "not yours to see"
    return null;
  end if;
  return jsonb_build_object('account_id', a.id, 'username', a.username, 'display_name', a.display_name, 'status', a.status,
    'roles_here', coalesce((select jsonb_agg(jsonb_build_object('membership_id', m.id, 'role', m.role, 'status', m.status))
                             from app.memberships m where m.account_id = a.id and m.school_id = c.school_id), '[]'::jsonb));
end $$;

create or replace function private.grant_membership(p_rev integer, p_account_id uuid, p_role text, p_admissions_duty boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_org uuid; m app.memberships; a app.accounts;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('users.manage');
  if p_role not in ('owner','admin','principal','accountant','teacher','parent','student') then
    perform private.fail('VALIDATION_ERROR', 'Unknown role');
  end if;
  if coalesce(p_admissions_duty, false) and p_role not in ('admin','principal','accountant','teacher') then
    perform private.fail('VALIDATION_ERROR', 'Admissions duty applies only to staff roles');
  end if;
  select * into a from app.accounts where id = p_account_id;
  select organization_id into v_org from app.schools where id = c.school_id;
  if a.id is null or not (c.via_operator or exists (
        select 1 from app.memberships x join app.schools s on s.id = x.school_id
         where x.account_id = a.id and s.organization_id = v_org)) then
    perform private.fail('NOT_FOUND', 'Account not found. For a person from another organization, ask the Operator.');
  end if;
  if a.status <> 'active' then perform private.fail('VALIDATION_ERROR', 'That account is disabled'); end if;

  select * into m from app.memberships where account_id = p_account_id and school_id = c.school_id and role = p_role for update;
  if found then
    update app.memberships
       set status = 'active', disabled_at = null, disabled_by = null,
           admissions_duty = coalesce(p_admissions_duty, admissions_duty)
     where id = m.id returning * into m;
  else
    insert into app.memberships (account_id, school_id, role, admissions_duty, granted_by)
    values (p_account_id, c.school_id, p_role, coalesce(p_admissions_duty, false), c.account_id) returning * into m;
  end if;
  insert into private.auth_events (account_id, actor_id, event, school_id, detail)
  values (p_account_id, c.account_id, 'membership_granted', c.school_id,
          jsonb_build_object('role', p_role, 'admissions_duty', m.admissions_duty));
  return jsonb_build_object('membership_id', m.id, 'role', m.role, 'status', m.status,
                            'admissions_duty', m.admissions_duty, 'version', m.version);
end $$;

create or replace function private.set_admissions_duty(p_rev integer, p_membership_id uuid, p_on boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; m app.memberships;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('users.manage');
  select * into m from app.memberships where id = p_membership_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Membership not found'); end if;
  if p_expected_version is not null and m.version <> p_expected_version then
    perform private.fail('CONFLICT', 'This user changed since you opened it');
  end if;
  if p_on and m.role not in ('admin','principal','accountant','teacher') then
    perform private.fail('VALIDATION_ERROR', 'Admissions duty applies only to staff roles');
  end if;
  update app.memberships set admissions_duty = p_on where id = m.id returning * into m;
  return jsonb_build_object('membership_id', m.id, 'admissions_duty', m.admissions_duty, 'version', m.version);
end $$;

-- Link (or unlink with p_account_id = null) a login to a staff / guardian / student record.
-- The account must hold the matching role in this school.
create or replace function private.link_account(p_rev integer, p_kind text, p_record_id uuid, p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_cur uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('users.manage');
  if p_kind not in ('staff','guardian','student') then perform private.fail('VALIDATION_ERROR', 'kind must be staff, guardian or student'); end if;
  if p_account_id is not null and not exists (
       select 1 from app.memberships m where m.account_id = p_account_id and m.school_id = c.school_id and m.status = 'active'
          and ((p_kind = 'staff' and m.role in ('owner','admin','principal','accountant','teacher'))
            or (p_kind = 'guardian' and m.role = 'parent')
            or (p_kind = 'student' and m.role = 'student'))) then
    perform private.fail('VALIDATION_ERROR',
      case p_kind when 'staff' then 'Give this login a staff role in this school first'
                  when 'guardian' then 'Give this login the Parent role in this school first'
                  else 'Give this login the Student role in this school first' end);
  end if;
  if p_kind = 'staff' then
    select account_id into v_cur from app.staff where id = p_record_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Staff record not found'); end if;
    if p_account_id is not null and exists (select 1 from app.staff where school_id = c.school_id and account_id = p_account_id and id <> p_record_id) then
      perform private.fail('DUPLICATE', 'That login is already linked to another staff record');
    end if;
    update app.staff set account_id = p_account_id where id = p_record_id;
  elsif p_kind = 'guardian' then
    select account_id into v_cur from app.guardians where id = p_record_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Guardian not found'); end if;
    update app.guardians set account_id = p_account_id where id = p_record_id;
  else
    select account_id into v_cur from app.students where id = p_record_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Student not found'); end if;
    if p_account_id is not null and exists (select 1 from app.students where school_id = c.school_id and account_id = p_account_id and id <> p_record_id) then
      perform private.fail('DUPLICATE', 'That login is already linked to another student');
    end if;
    update app.students set account_id = p_account_id where id = p_record_id;
  end if;
  perform private.log_event('users.account_linked', p_kind, p_record_id::text,
                            jsonb_build_object('account_id', p_account_id, 'previous_account_id', v_cur));
  return jsonb_build_object('kind', p_kind, 'record_id', p_record_id, 'account_id', p_account_id);
end $$;

-- ---------------------------------------------------------------- public wrappers
create or replace function public.get_calendar(p_ctx_rev integer, p_academic_year_id uuid, p_audience text,
                                               p_staff_group_id uuid default null, p_from date default null, p_to date default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_calendar(p_ctx_rev, p_academic_year_id, p_audience, p_staff_group_id, p_from, p_to) $$;
create or replace function public.find_school_account(p_ctx_rev integer, p_username text)
returns jsonb language sql security invoker set search_path = '' as $$ select private.find_school_account(p_ctx_rev, p_username) $$;
create or replace function public.grant_membership(p_ctx_rev integer, p_account_id uuid, p_role text, p_admissions_duty boolean default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.grant_membership(p_ctx_rev, p_account_id, p_role, p_admissions_duty) $$;
create or replace function public.set_admissions_duty(p_ctx_rev integer, p_membership_id uuid, p_on boolean, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.set_admissions_duty(p_ctx_rev, p_membership_id, p_on, p_expected_version) $$;
create or replace function public.link_account(p_ctx_rev integer, p_kind text, p_record_id uuid, p_account_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.link_account(p_ctx_rev, p_kind, p_record_id, p_account_id) $$;

-- Lockdown (same rule as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.get_calendar(integer, uuid, text, uuid, date, date), private.find_school_account(integer, text),
  private.grant_membership(integer, uuid, text, boolean), private.set_admissions_duty(integer, uuid, boolean, integer),
  private.link_account(integer, text, uuid, uuid)
to authenticated;
grant execute on function
  public.get_calendar(integer, uuid, text, uuid, date, date), public.list_staff_groups(integer, boolean),
  public.list_class_subjects(integer, uuid, uuid), public.list_teaching_assignments(integer, uuid, uuid, uuid, date),
  public.get_lead(integer, uuid), public.search_guardians(integer, text), public.list_school_users(integer),
  public.find_school_account(integer, text), public.grant_membership(integer, uuid, text, boolean),
  public.set_admissions_duty(integer, uuid, boolean, integer), public.link_account(integer, text, uuid, uuid)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
