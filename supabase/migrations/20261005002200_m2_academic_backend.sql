-- =============================================================================
-- PrimeCampus V1 — 2200 M2 academic backend (timetable, lessons, attendance, diary, homework)
-- Gaps found before handing M2 to the coding agent:
--  * capabilities: never null (parent/student got null); new 'child.view' (parent, student) and
--    'lessons.teach' (teacher) so the UI never derives navigation from role names
--  * timetable: list_timetable_versions, get_timetable_version, discard_timetable_draft;
--    save_timetable_draft now version-checked, hinted validation, calendar-aware unassigned count (incl. Sunday)
--  * lessons: generate_lesson_sessions also REFRESHES unused future lessons after a timetable change
--    (used lessons are never touched and are reported); update_lesson_session guards; get_schedule_range;
--    list_substitutions; assign_substitute checks teaching/employment and returns version
--  * attendance: get_staff_attendance roster; get_student_attendance_records (per day/lesson);
--    get_marking_roster.can_mark; out-of-year/holiday guards; overview expected=0 on holidays
--  * diary: get_diary_entry, list_diary_entries, get_student_diary; hinted body validation
--  * homework: list_homework with progress; save_homework hinted validation, no homework on cancelled
--    lessons, assigned_by = lesson teacher when Admin creates; get_student_homework range limit, teacher,
--    no duplicate rows; mark_homework_checks hinted validation
--  * get_teacher_today: eligible counts and lesson version
-- =============================================================================

create or replace function private.role_has_cap(p_role text, p_cap text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case p_cap
    when 'school.member'           then p_role is not null
    when 'staff.member'            then p_role in ('operator','owner','admin','principal','accountant','teacher')
    when 'setup.manage'            then p_role in ('operator','admin')
    when 'users.manage'            then p_role in ('operator','admin')
    when 'students.read_all'       then p_role in ('operator','admin','principal','accountant')
    when 'students.manage'         then p_role in ('operator','admin')
    when 'students.sensitive'      then p_role in ('operator','admin')
    when 'admissions.manage'       then p_role in ('operator','admin')
    when 'imports.manage'          then p_role in ('operator','admin')
    when 'timetable.read_all'      then p_role in ('operator','admin','principal','teacher')
    when 'timetable.manage'        then p_role in ('operator','admin')
    when 'attendance.read_all'     then p_role in ('operator','admin','principal')
    when 'attendance.mark_any'     then p_role in ('operator','admin')
    when 'attendance.summary'      then p_role in ('operator','admin','principal','owner')
    when 'academic.read_all'       then p_role in ('operator','admin','principal')
    when 'academic.correct'        then p_role in ('operator','admin')
    when 'fees.read'               then p_role in ('operator','admin','accountant','owner')
    when 'fees.manage'             then p_role in ('operator','admin','accountant')
    when 'staff.read'              then p_role in ('operator','admin','principal','owner','accountant','teacher')
    when 'staff.manage'            then p_role in ('operator','admin')
    when 'staff_attendance.read'   then p_role in ('operator','admin','principal')
    when 'staff_attendance.manage' then p_role in ('operator','admin')
    when 'staff_finance.read'      then p_role in ('operator','admin','owner')
    when 'staff_finance.manage'    then p_role in ('operator','admin')
    when 'export.full'             then p_role in ('operator','admin')
    when 'audit.read'              then p_role = 'operator'
    when 'child.view'              then p_role in ('parent','student')
    when 'lessons.teach'           then p_role = 'teacher'
    else false end, false)
$$;

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
    'capabilities', (select coalesce(jsonb_agg(cap), '[]'::jsonb) from unnest(array[
        'staff.member', 'child.view', 'lessons.teach',
        'setup.manage','users.manage','students.read_all','students.manage','students.sensitive','admissions.manage',
        'imports.manage','timetable.read_all','timetable.manage','attendance.read_all','attendance.mark_any',
        'attendance.summary','academic.read_all','academic.correct','fees.read','fees.manage','staff.read',
        'staff.manage','staff_attendance.read','staff_attendance.manage','staff_finance.read',
        'staff_finance.manage','export.full','audit.read']) cap
        where private.role_has_cap(c.role, cap) or (cap = 'admissions.manage' and c.admissions_duty)));
end $$;

create or replace function private.get_date_schedule(p_rev integer, p_date date, p_section_id uuid, p_staff_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if not private.has_cap('timetable.read_all') then
    -- Parent/Student: only the child's section on that date
    if private.ctx_child_id() is null then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
    select p.section_id into p_section_id from app.placements p
     where p.student_id = private.ctx_child_id() and p.effective_from <= p_date
       and (p.effective_to is null or p.effective_to > p_date);
    if p_section_id is null then return '[]'::jsonb; end if;
    p_staff_id := null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'lesson_session_id', ls.id, 'section_id', ls.section_id,
      'section', cl.name || ' ' || sec.name, 'slot_ordinal', ls.slot_ordinal, 'slot_label', ls.slot_label,
      'start_time', ls.start_time, 'end_time', ls.end_time, 'subject', sub.name, 'subject_id', ls.subject_id,
      'planned_staff_id', ls.planned_staff_id, 'planned_staff', ps.full_name,
      'actual_staff_id', ls.actual_staff_id, 'actual_staff', ast.full_name,
      'status', ls.status, 'cancel_reason', ls.cancel_reason, 'version', ls.version,
      'planned_teacher_absent', (select sa.status = 'A' from app.staff_attendance sa
                                  where sa.staff_id = ls.planned_staff_id and sa.attendance_date = ls.session_date),
      'planned_teacher_half_day', (select sa.status = 'H' from app.staff_attendance sa
                                  where sa.staff_id = ls.planned_staff_id and sa.attendance_date = ls.session_date),
      'has_diary', exists (select 1 from app.diary_entries de where de.lesson_session_id = ls.id),
      'homework_count', (select count(*) from app.homework_assignments h where h.lesson_session_id = ls.id and h.status = 'active'),
      'is_substituted', ls.actual_staff_id is distinct from ls.planned_staff_id,
      'unassigned', ls.actual_staff_id is null
    ) order by cl.sort_order, sec.name, ls.slot_ordinal)
    from app.lesson_sessions ls
    join app.sections sec on sec.id = ls.section_id
    join app.classes cl on cl.id = sec.class_id
    join app.subjects sub on sub.id = ls.subject_id
    left join app.staff ps on ps.id = ls.planned_staff_id
    left join app.staff ast on ast.id = ls.actual_staff_id
   where ls.school_id = c.school_id and ls.session_date = p_date
     and (p_section_id is null or ls.section_id = p_section_id)
     and (p_staff_id is null or ls.actual_staff_id = p_staff_id or ls.planned_staff_id = p_staff_id)), '[]'::jsonb);
end $$;

create or replace function private.assign_substitute(p_rev integer, p_lesson_session_id bigint, p_staff_id uuid,
                                                     p_reason text, p_conflict_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_conflict boolean; v_absent boolean; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'Lesson is cancelled'); end if;
  if not exists (select 1 from app.staff where id = p_staff_id and school_id = c.school_id and status = 'active' and is_teaching
                   and joined_on <= v_ls.session_date and (left_on is null or left_on >= v_ls.session_date)) then
    perform private.fail('VALIDATION_ERROR', 'Substitute must be active teaching staff employed on that date');
  end if;
  if length(p_reason) > 500 or length(p_conflict_reason) > 500 then
    perform private.fail('VALIDATION_ERROR', 'Reasons can be at most 500 characters');
  end if;
  if p_staff_id = v_ls.planned_staff_id then
    perform private.fail('VALIDATION_ERROR', 'Use "remove substitute" to return the lesson to its planned teacher');
  end if;

  v_conflict := exists (select 1 from app.lesson_sessions o
                         where o.actual_staff_id = p_staff_id and o.session_date = v_ls.session_date
                           and o.status = 'scheduled' and o.id <> v_ls.id
                           and o.start_time < v_ls.end_time and o.end_time > v_ls.start_time);
  v_absent := exists (select 1 from app.staff_attendance where staff_id = p_staff_id
                         and attendance_date = v_ls.session_date and status = 'A');
  if (v_conflict or v_absent) and coalesce(btrim(p_conflict_reason), '') = '' then
    perform private.fail('CONFLICT',
      case when v_absent then 'This teacher is marked absent that day' else 'This teacher has an overlapping lesson' end
      || '. Give a reason to assign anyway.',
      jsonb_build_object('has_conflict', v_conflict, 'is_absent', v_absent));
  end if;

  update app.substitutions set status = 'replaced', ended_at = now(), ended_by = c.account_id
   where lesson_session_id = v_ls.id and status = 'active';
  insert into app.substitutions (school_id, lesson_session_id, original_staff_id, substitute_staff_id, reason,
                                 conflict_override_reason, assigned_by)
  values (c.school_id, v_ls.id, v_ls.planned_staff_id, p_staff_id, p_reason,
          case when v_conflict or v_absent then p_conflict_reason end, c.account_id)
  returning id into v_id;
  update app.lesson_sessions set actual_staff_id = p_staff_id where id = v_ls.id;
  perform private.log_event('timetable.substitute.assigned', 'lesson_sessions', v_ls.id::text,
                            jsonb_build_object('substitute_staff_id', p_staff_id, 'conflict_overridden', v_conflict or v_absent));
  return jsonb_build_object('substitution_id', v_id, 'lesson_session_id', v_ls.id,
                            'conflict_overridden', v_conflict or v_absent,
                            'version', (select version from app.lesson_sessions where id = v_ls.id));
end $$;

create or replace function private.remove_substitute(p_rev integer, p_lesson_session_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  update app.substitutions set status = 'cancelled', ended_at = now(), ended_by = c.account_id
   where lesson_session_id = v_ls.id and status = 'active';
  update app.lesson_sessions set actual_staff_id = planned_staff_id where id = v_ls.id;
  return jsonb_build_object('lesson_session_id', v_ls.id, 'version', (select version from app.lesson_sessions where id = v_ls.id));
end $$;

create or replace function private.get_marking_roster(p_rev integer, p_kind text, p_section_id uuid, p_date date,
                                                      p_lesson_session_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_allowed boolean;
begin
  select * into c from private.require_ctx(p_rev);
  if p_kind = 'period' then
    select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
    if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
    p_section_id := v_ls.section_id; p_date := v_ls.session_date;
    v_allowed := private.has_cap('attendance.read_all') or (c.role = 'teacher' and c.staff_id = v_ls.actual_staff_id);
  elsif p_kind = 'daily' then
    if not exists (select 1 from app.sections where id = p_section_id and school_id = c.school_id) then
      perform private.fail('NOT_FOUND', 'Section not found');
    end if;
    v_allowed := private.has_cap('attendance.read_all')
                 or (c.role = 'teacher' and private.is_class_teacher(c.staff_id, p_section_id, p_date));
  else
    perform private.fail('VALIDATION_ERROR', 'kind must be daily or period');
  end if;
  if not v_allowed then perform private.fail('FORBIDDEN', 'You are not assigned to mark this attendance'); end if;

  return jsonb_build_object(
    'section_id', p_section_id, 'date', p_date, 'lesson_session_id', p_lesson_session_id,
    'mode_on_date', private.attendance_mode_on(c.school_id, p_date),
    'lesson_status', v_ls.status,
    'can_mark', case when p_kind = 'period'
                     then private.has_cap('attendance.mark_any') or (c.role = 'teacher' and c.staff_id = v_ls.actual_staff_id)
                     else private.has_cap('attendance.mark_any') or (c.role = 'teacher' and private.is_class_teacher(c.staff_id, p_section_id, p_date)) end,
    'day', (select to_jsonb(r) from private.resolve_day(c.school_id, 'student', null, p_date) r),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'student_id', e.student_id, 'roll_no', e.roll_no, 'name', e.full_name, 'admission_no', e.admission_no,
               'status', coalesce(d.status, pa.status), 'version', coalesce(d.version, pa.version))
             order by e.roll_no nulls last, e.full_name)
        from private.eligible_students(p_section_id, p_date) e
        left join app.student_daily_attendance d
          on p_kind = 'daily' and d.student_id = e.student_id and d.attendance_date = p_date
        left join app.student_period_attendance pa
          on p_kind = 'period' and pa.lesson_session_id = p_lesson_session_id and pa.student_id = e.student_id
    ), '[]'::jsonb));
end $$;

create or replace function private.mark_student_attendance(p_rev integer, p_operation_id uuid, p_kind text,
                                                           p_section_id uuid, p_date date, p_lesson_session_id bigint,
                                                           p_marks jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c record; v_ls app.lesson_sessions; v_today date; v_sub bigint; v_fp text; v_prev jsonb;
  m jsonb; v_sid uuid; v_status text; v_exp integer; v_old_status text; v_old_ver integer;
  v_marked integer := 0; v_changed integer := 0; v_conflicts jsonb := '[]'; v_ok integer;
begin
  select * into c from private.require_ctx(p_rev);
  if jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) = 0 then
    perform private.fail('VALIDATION_ERROR', 'No marks supplied');
  end if;
  if jsonb_array_length(p_marks) > 100 then perform private.fail('LIMIT_REACHED', 'At most 100 students per save'); end if;

  v_fp := private.fingerprint(jsonb_build_object('k', p_kind, 's', p_section_id, 'd', p_date, 'l', p_lesson_session_id, 'm', p_marks));
  v_prev := private.idem_lookup(c.school_id, 'attendance.mark', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;

  if p_kind = 'period' then
    select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id for share;
    if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
    if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'Lesson is cancelled'); end if;
    p_section_id := v_ls.section_id; p_date := v_ls.session_date;
    if coalesce((select weight from private.resolve_day(c.school_id, 'student', null, p_date)), 0) = 0 then
      perform private.fail('VALIDATION_ERROR', 'That date is not a working day for students');
    end if;
    if private.attendance_mode_on(c.school_id, p_date) <> 'period' then
      perform private.fail('VALIDATION_ERROR', 'This school uses day-wise attendance on that date');
    end if;
    if not (private.has_cap('attendance.mark_any') or (c.role = 'teacher' and c.staff_id = v_ls.actual_staff_id)) then
      perform private.fail('FORBIDDEN', 'Only the teacher taking this lesson (or Admin) can mark it');
    end if;
  elsif p_kind = 'daily' then
    if not exists (select 1 from app.sections where id = p_section_id and school_id = c.school_id) then
      perform private.fail('NOT_FOUND', 'Section not found');
    end if;
    if private.attendance_mode_on(c.school_id, p_date) <> 'daily' then
      perform private.fail('VALIDATION_ERROR', 'This school uses period-wise attendance on that date');
    end if;
    if coalesce((select weight from private.resolve_day(c.school_id, 'student', null, p_date)), 0) = 0 then
      perform private.fail('VALIDATION_ERROR', 'That date is not a working day for students');
    end if;
    if not (private.has_cap('attendance.mark_any')
            or (c.role = 'teacher' and private.is_class_teacher(c.staff_id, p_section_id, p_date))) then
      perform private.fail('FORBIDDEN', 'Only the class teacher (or Admin) can mark day attendance');
    end if;
  else
    perform private.fail('VALIDATION_ERROR', 'kind must be daily or period');
  end if;

  v_today := private.school_today(c.school_id);
  if p_date > v_today then perform private.fail('VALIDATION_ERROR', 'Attendance cannot be marked for a future date'); end if;

  -- every student must be eligible on that date in that section
  if exists (select 1 from jsonb_array_elements(p_marks) x
              where (x->>'student_id')::uuid not in (select student_id from private.eligible_students(p_section_id, p_date))) then
    perform private.fail('VALIDATION_ERROR', 'Some students are not in this section on that date');
  end if;
  if (select count(distinct x->>'student_id') from jsonb_array_elements(p_marks) x) <> jsonb_array_length(p_marks) then
    perform private.fail('VALIDATION_ERROR', 'A student appears twice');
  end if;

  insert into app.attendance_submissions (school_id, kind, attendance_date, section_id, lesson_session_id,
                                          actor_id, actor_role, operation_id)
  values (c.school_id, 'student_' || p_kind, p_date, p_section_id, case when p_kind = 'period' then p_lesson_session_id end,
          c.account_id, c.role, p_operation_id)
  returning id into v_sub;

  -- stable order prevents deadlocks between concurrent savers
  for m in select x from jsonb_array_elements(p_marks) x order by x->>'student_id' loop
    v_sid := (m->>'student_id')::uuid; v_status := m->>'status'; v_exp := (m->>'expected_version')::integer;
    if (p_kind = 'daily' and v_status not in ('P','L','H','A')) or (p_kind = 'period' and v_status not in ('P','L','A')) then
      perform private.fail('VALIDATION_ERROR', format('Invalid status %s', v_status));
    end if;

    if p_kind = 'daily' then
      insert into app.student_daily_attendance (student_id, attendance_date, school_id, section_id, status, submission_id)
      values (v_sid, p_date, c.school_id, p_section_id, v_status, v_sub)
      on conflict (student_id, attendance_date) do nothing;
      get diagnostics v_ok = row_count;
      if v_ok > 0 then v_marked := v_marked + 1; continue; end if;
      select status, version into v_old_status, v_old_ver from app.student_daily_attendance
       where student_id = v_sid and attendance_date = p_date for update;
    else
      insert into app.student_period_attendance (lesson_session_id, student_id, school_id, attendance_date, status, submission_id)
      values (p_lesson_session_id, v_sid, c.school_id, p_date, v_status, v_sub)
      on conflict (lesson_session_id, student_id) do nothing;
      get diagnostics v_ok = row_count;
      if v_ok > 0 then v_marked := v_marked + 1; continue; end if;
      select status, version into v_old_status, v_old_ver from app.student_period_attendance
       where lesson_session_id = p_lesson_session_id and student_id = v_sid for update;
    end if;

    if v_old_status = v_status then continue; end if;                     -- no-op
    if v_exp is null or v_exp <> v_old_ver then                           -- stale view of this student
      v_conflicts := v_conflicts || jsonb_build_object('student_id', v_sid, 'current_status', v_old_status,
                                                       'current_version', v_old_ver);
      continue;
    end if;
    if p_kind = 'daily' then
      update app.student_daily_attendance set status = v_status, submission_id = v_sub, version = version + 1
       where student_id = v_sid and attendance_date = p_date;
    else
      update app.student_period_attendance set status = v_status, submission_id = v_sub, version = version + 1
       where lesson_session_id = p_lesson_session_id and student_id = v_sid;
    end if;
    insert into app.attendance_changes (school_id, kind, person_id, attendance_date, lesson_session_id,
                                        old_status, new_status, submission_id)
    values (c.school_id, 'student_' || p_kind, v_sid, p_date,
            case when p_kind = 'period' then p_lesson_session_id end, v_old_status, v_status, v_sub);
    v_changed := v_changed + 1;
  end loop;

  update app.attendance_submissions set marked_count = v_marked, changed_count = v_changed where id = v_sub;

  v_prev := jsonb_build_object(
    'submission_id', v_sub, 'marked', v_marked, 'changed', v_changed, 'conflicts', v_conflicts,
    'eligible', (select count(*) from private.eligible_students(p_section_id, p_date)),
    'unmarked_remaining', (select count(*) from private.eligible_students(p_section_id, p_date) e
                            where not exists (select 1 from app.student_daily_attendance d
                                               where p_kind = 'daily' and d.student_id = e.student_id and d.attendance_date = p_date)
                              and not exists (select 1 from app.student_period_attendance pa
                                               where p_kind = 'period' and pa.lesson_session_id = p_lesson_session_id
                                                 and pa.student_id = e.student_id)));
  perform private.idem_store(c.school_id, 'attendance.mark', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

create or replace function private.get_attendance_overview(p_rev integer, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_mode text; v_weight numeric;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('attendance.summary');
  v_mode := private.attendance_mode_on(c.school_id, p_date);
  v_weight := coalesce((select weight from private.resolve_day(c.school_id, 'student', null, p_date)), 0);
  return jsonb_build_object('date', p_date, 'mode', v_mode,
    'day', (select to_jsonb(r) from private.resolve_day(c.school_id, 'student', null, p_date) r),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'section_id', sec.id, 'section', cl.name || ' ' || sec.name,
        'eligible', (select count(*) from private.eligible_students(sec.id, p_date)),
        'marked', case when v_mode = 'daily'
                       then (select count(*) from app.student_daily_attendance d where d.section_id = sec.id and d.attendance_date = p_date)
                       else (select count(*) from app.student_period_attendance pa join app.lesson_sessions ls on ls.id = pa.lesson_session_id
                              where ls.section_id = sec.id and ls.session_date = p_date and ls.status = 'scheduled') end,
        'expected', case when v_mode = 'daily'
                         then case when v_weight > 0 then (select count(*) from private.eligible_students(sec.id, p_date)) else 0 end
                         else (select count(*) from private.eligible_students(sec.id, p_date))
                              * (select count(*) from app.lesson_sessions ls where ls.section_id = sec.id
                                   and ls.session_date = p_date and ls.status = 'scheduled') end,
        'present', case when v_mode = 'daily'
                        then (select coalesce(sum(case status when 'H' then 0.5 when 'A' then 0 else 1 end), 0)
                                from app.student_daily_attendance d where d.section_id = sec.id and d.attendance_date = p_date)
                        else (select count(*) filter (where pa.status <> 'A') from app.student_period_attendance pa
                                join app.lesson_sessions ls on ls.id = pa.lesson_session_id
                               where ls.section_id = sec.id and ls.session_date = p_date and ls.status = 'scheduled') end
      ) order by cl.sort_order, sec.name)
      from app.sections sec join app.classes cl on cl.id = sec.class_id
      join app.academic_years ay on ay.id = sec.academic_year_id
     where sec.school_id = c.school_id and sec.status = 'active'
       and p_date between ay.start_date and ay.end_date), '[]'::jsonb));
end $$;

create or replace function private.save_diary_entry(p_rev integer, p_lesson_session_id bigint, p_body text,
                                                    p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_de app.diary_entries;
begin
  select * into c from private.require_ctx(p_rev);
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  if not private.can_teach_lesson(c.role, c.staff_id, v_ls) then
    perform private.fail('FORBIDDEN', 'Only the teacher who took this lesson (or Admin) can write its diary');
  end if;
  if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'Lesson was cancelled'); end if;
  if v_ls.session_date > private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'Diary is for lessons that have happened');
  end if;
  if length(btrim(coalesce(p_body, ''))) = 0 then perform private.fail('VALIDATION_ERROR', 'Write something in the diary entry'); end if;
  if length(p_body) > 4000 then perform private.fail('VALIDATION_ERROR', 'Diary entry can be at most 4000 characters'); end if;
  select * into v_de from app.diary_entries where lesson_session_id = v_ls.id for update;
  if not found then
    if p_expected_version is not null then perform private.fail('CONFLICT', 'Diary entry no longer exists'); end if;
    insert into app.diary_entries (school_id, lesson_session_id, body, recorded_by, recorded_by_staff)
    values (c.school_id, v_ls.id, p_body, c.account_id, c.staff_id) returning * into v_de;
  else
    if p_expected_version is null or p_expected_version <> v_de.version then
      perform private.fail('CONFLICT', 'Someone else updated this diary entry. Reload to see it.');
    end if;
    update app.diary_entries set body = p_body, updated_by = c.account_id where id = v_de.id returning * into v_de;
  end if;
  return jsonb_build_object('diary_entry_id', v_de.id, 'version', v_de.version,
                            'lesson_date', v_ls.session_date, 'entered_at', v_de.updated_at);
end $$;

create or replace function private.mark_homework_checks(p_rev integer, p_operation_id uuid, p_assignment_id uuid,
                                                        p_observed_on date, p_checks jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_hw app.homework_assignments; v_fp text; v_prev jsonb; m jsonb; v_old app.homework_checks;
        v_saved integer := 0; v_conflicts jsonb := '[]'; v_id bigint;
begin
  select * into c from private.require_ctx(p_rev);
  select * into v_hw from app.homework_assignments where id = p_assignment_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Homework not found'); end if;
  if v_hw.status <> 'active' then perform private.fail('VALIDATION_ERROR', 'Homework was cancelled'); end if;
  if not private.can_check_homework(c.role, c.staff_id, v_hw, p_observed_on) then
    perform private.fail('FORBIDDEN', 'You are not responsible for checking this homework');
  end if;
  if p_observed_on < v_hw.assigned_on or p_observed_on > private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'Checked date must be between the assigned date and today');
  end if;
  if jsonb_typeof(p_checks) <> 'array' or jsonb_array_length(p_checks) not between 1 and 100 then
    perform private.fail('VALIDATION_ERROR', 'Supply 1–100 students');
  end if;
  v_fp := private.fingerprint(jsonb_build_object('a', p_assignment_id, 'o', p_observed_on, 'c', p_checks));
  v_prev := private.idem_lookup(c.school_id, 'homework.check', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  if exists (select 1 from jsonb_array_elements(p_checks) x
              where (x->>'student_id')::uuid not in (select student_id from private.eligible_students(v_hw.section_id, v_hw.assigned_on))
                 or x->>'completion' not in ('completed','not_completed')
                 or coalesce(x->>'correction', 'none') not in ('none','required','done')) then
    perform private.fail('VALIDATION_ERROR', 'Invalid student or status in the list');
  end if;
  if exists (select 1 from jsonb_array_elements(p_checks) x
              where (x->>'completed_on' is not null and x->>'completion' <> 'completed')
                 or length(x->>'comment') > 1000) then
    perform private.fail('VALIDATION_ERROR', 'A completion date is only for completed homework, and comments can be at most 1000 characters');
  end if;
  if exists (select 1 from jsonb_array_elements(p_checks) x where x->>'completed_on' is not null
               and ((x->>'completed_on')::date < v_hw.assigned_on or (x->>'completed_on')::date > p_observed_on)) then
    perform private.fail('VALIDATION_ERROR', 'Completion date must be between the assigned date and the checked date');
  end if;

  for m in select x from jsonb_array_elements(p_checks) x order by x->>'student_id' loop
    select * into v_old from app.homework_checks
     where assignment_id = v_hw.id and student_id = (m->>'student_id')::uuid for update;
    if not found then
      if (m->>'expected_version') is not null then
        v_conflicts := v_conflicts || jsonb_build_object('student_id', m->>'student_id', 'reason', 'missing'); continue;
      end if;
      insert into app.homework_checks (school_id, assignment_id, student_id, completion, correction, observed_on,
                                       completed_on, comment, checked_by)
      values (c.school_id, v_hw.id, (m->>'student_id')::uuid, m->>'completion', coalesce(m->>'correction', 'none'),
              p_observed_on, (m->>'completed_on')::date, m->>'comment', c.account_id)
      on conflict (assignment_id, student_id) do nothing
      returning id into v_id;
      if v_id is null then
        v_conflicts := v_conflicts || jsonb_build_object('student_id', m->>'student_id', 'reason', 'concurrent');
        continue;
      end if;
      insert into app.homework_check_changes (school_id, check_id, new_completion, new_correction, observed_on, changed_by)
      values (c.school_id, v_id, m->>'completion', coalesce(m->>'correction', 'none'), p_observed_on, c.account_id);
      v_saved := v_saved + 1; v_id := null;
    else
      if (m->>'expected_version') is null or (m->>'expected_version')::integer <> v_old.version then
        v_conflicts := v_conflicts || jsonb_build_object('student_id', m->>'student_id', 'current_version', v_old.version,
                                                         'current_state', v_old.completion);
        continue;
      end if;
      update app.homework_checks
         set completion = m->>'completion', correction = coalesce(m->>'correction', 'none'), observed_on = p_observed_on,
             completed_on = (m->>'completed_on')::date, comment = m->>'comment', checked_by = c.account_id,
             entered_at = now()
       where id = v_old.id;
      insert into app.homework_check_changes (school_id, check_id, old_completion, new_completion, old_correction,
                                              new_correction, observed_on, changed_by)
      values (c.school_id, v_old.id, v_old.completion, m->>'completion', v_old.correction,
              coalesce(m->>'correction', 'none'), p_observed_on, c.account_id);
      v_saved := v_saved + 1;
    end if;
  end loop;
  v_prev := jsonb_build_object('saved', v_saved, 'conflicts', v_conflicts);
  perform private.idem_store(c.school_id, 'homework.check', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

create or replace function public.get_teacher_today(p_ctx_rev integer, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_date date;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  if c.staff_id is null then perform private.fail('FORBIDDEN', 'No staff record linked to this login'); end if;
  v_date := coalesce(p_date, private.school_today(c.school_id));
  return jsonb_build_object('date', v_date,
    'mode', private.attendance_mode_on(c.school_id, v_date),
    'lessons', coalesce((select jsonb_agg(jsonb_build_object(
        'lesson_session_id', ls.id, 'slot_label', ls.slot_label, 'start_time', ls.start_time, 'end_time', ls.end_time,
        'section_id', ls.section_id, 'section', cl.name || ' ' || sec.name, 'subject', sub.name, 'status', ls.status,
        'is_substitution', ls.planned_staff_id is distinct from c.staff_id,
        'attendance_marked', (select count(*) from app.student_period_attendance pa where pa.lesson_session_id = ls.id),
        'eligible', (select count(*) from private.eligible_students(ls.section_id, v_date)),
        'version', ls.version,
        'has_diary', exists (select 1 from app.diary_entries d where d.lesson_session_id = ls.id),
        'homework_count', (select count(*) from app.homework_assignments h where h.lesson_session_id = ls.id and h.status = 'active'))
        order by ls.start_time)
      from app.lesson_sessions ls join app.sections sec on sec.id = ls.section_id join app.classes cl on cl.id = sec.class_id
      join app.subjects sub on sub.id = ls.subject_id
     where ls.school_id = c.school_id and ls.session_date = v_date and ls.actual_staff_id = c.staff_id), '[]'),
    'class_teacher_sections', coalesce((select jsonb_agg(jsonb_build_object('section_id', ta.section_id,
        'section', cl.name || ' ' || sec.name,
        'daily_marked', (select count(*) from app.student_daily_attendance d where d.section_id = ta.section_id and d.attendance_date = v_date),
        'eligible', (select count(*) from private.eligible_students(ta.section_id, v_date))))
      from app.teaching_assignments ta join app.sections sec on sec.id = ta.section_id join app.classes cl on cl.id = sec.class_id
     where ta.staff_id = c.staff_id and ta.kind = 'class_teacher' and ta.effective_from <= v_date
       and (ta.effective_to is null or ta.effective_to > v_date)), '[]'),
    'homework_to_check', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', h.id, 'section_id', h.section_id,
        'due_on', h.due_on, 'checked', (select count(*) from app.homework_checks hc where hc.assignment_id = h.id)))
      from app.homework_assignments h
     where h.school_id = c.school_id and h.status = 'active' and h.assigned_by_staff = c.staff_id
       and h.due_on between v_date - 14 and v_date), '[]'));
end $$;

-- -----------------------------------------------------------------------------
-- Timetable: weekdays that need periods (student calendar pattern; Mon–Sat if none)
-- -----------------------------------------------------------------------------
create or replace function private.tt_weekdays(p_school uuid, p_year uuid)
returns integer[] language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select array_agg(cp.weekday::int order by cp.weekday) from app.calendar_patterns cp
      where cp.school_id = p_school and cp.academic_year_id = p_year and cp.audience = 'student'
        and cp.staff_group_id is null and cp.day_type in ('working','half_day')),
    array[1,2,3,4,5,6])
$$;

create or replace function private.tt_unassigned(p_version_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int
    from app.timetable_versions tv
    join app.schedule_slots ss on ss.period_schedule_id = tv.period_schedule_id and ss.kind = 'period'
    cross join lateral unnest(private.tt_weekdays(tv.school_id, tv.academic_year_id)) wd
   where tv.id = p_version_id
     and not exists (select 1 from app.timetable_entries te where te.timetable_version_id = tv.id
                       and te.weekday = wd and te.slot_ordinal = ss.ordinal)
$$;

create or replace function private.list_timetable_versions(p_rev integer, p_section_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.read_all');
  if not exists (select 1 from app.sections where id = p_section_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Section not found');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'timetable_version_id', tv.id, 'status', tv.status, 'effective_from', tv.effective_from,
      'effective_to', tv.effective_to, 'period_schedule_id', tv.period_schedule_id, 'period_schedule', ps.name,
      'copied_from_id', tv.copied_from_id, 'version', tv.version, 'updated_at', tv.updated_at,
      'entry_count', (select count(*) from app.timetable_entries te where te.timetable_version_id = tv.id),
      'unassigned_teacher_count', (select count(*) from app.timetable_entries te where te.timetable_version_id = tv.id and te.staff_id is null))
      order by case tv.status when 'draft' then 0 when 'active' then 1 else 2 end, tv.effective_from desc)
    from app.timetable_versions tv join app.period_schedules ps on ps.id = tv.period_schedule_id
   where tv.school_id = c.school_id and tv.section_id = p_section_id), '[]'::jsonb);
end $$;

create or replace function private.get_timetable_version(p_rev integer, p_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; tv app.timetable_versions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.read_all');
  select * into tv from app.timetable_versions where id = p_version_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Timetable not found'); end if;
  return jsonb_build_object(
    'timetable_version_id', tv.id, 'section_id', tv.section_id,
    'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = tv.section_id),
    'class_id', (select class_id from app.sections where id = tv.section_id),
    'academic_year_id', tv.academic_year_id, 'period_schedule_id', tv.period_schedule_id,
    'period_schedule', (select name from app.period_schedules where id = tv.period_schedule_id),
    'effective_from', tv.effective_from, 'effective_to', tv.effective_to, 'status', tv.status,
    'copied_from_id', tv.copied_from_id, 'version', tv.version, 'can_edit', tv.status = 'draft' and private.has_cap('timetable.manage'),
    'weekdays', to_jsonb(private.tt_weekdays(tv.school_id, tv.academic_year_id)),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('ordinal', ordinal, 'label', label, 'kind', kind,
                         'start_time', start_time, 'end_time', end_time) order by ordinal)
                       from app.schedule_slots where period_schedule_id = tv.period_schedule_id), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('weekday', te.weekday, 'slot_ordinal', te.slot_ordinal,
                           'subject_id', te.subject_id, 'subject', sub.name, 'staff_id', te.staff_id, 'staff', st.full_name)
                           order by te.weekday, te.slot_ordinal)
                         from app.timetable_entries te join app.subjects sub on sub.id = te.subject_id
                         left join app.staff st on st.id = te.staff_id
                        where te.timetable_version_id = tv.id), '[]'::jsonb),
    'conflicts', private.timetable_conflicts(tv.id),
    'unassigned_periods', private.tt_unassigned(tv.id));
end $$;

-- Replaces 1300 save_timetable_draft: version check, hinted validation, calendar-aware unassigned count.
drop function if exists public.save_timetable_draft(integer, uuid, uuid, date, jsonb, uuid);
create or replace function private.save_timetable_draft(p_rev integer, p_section_id uuid, p_period_schedule_id uuid,
                                                        p_effective_from date, p_entries jsonb, p_version_id uuid,
                                                        p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_sec record; tv app.timetable_versions; v_x jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  if jsonb_typeof(p_entries) <> 'array' then perform private.fail('VALIDATION_ERROR', 'Entries must be a list'); end if;
  if jsonb_array_length(p_entries) > 140 then perform private.fail('LIMIT_REACHED', 'Too many entries'); end if;
  select s.id, s.academic_year_id, ay.start_date, ay.end_date into v_sec
    from app.sections s join app.academic_years ay on ay.id = s.academic_year_id
   where s.id = p_section_id and s.school_id = c.school_id;
  if v_sec.id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  if not exists (select 1 from app.period_schedules where id = p_period_schedule_id and school_id = c.school_id and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose an active bell schedule');
  end if;
  if p_effective_from is null or p_effective_from not between v_sec.start_date and v_sec.end_date then
    perform private.fail('VALIDATION_ERROR', 'Start date must be inside the section''s academic year');
  end if;
  for v_x in select * from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_x->'weekday') <> 'number' or (v_x->>'weekday')::int not between 1 and 7
       or jsonb_typeof(v_x->'slot_ordinal') <> 'number' then
      perform private.fail('VALIDATION_ERROR', 'Each entry needs a weekday (1–7) and a period');
    end if;
    if v_x->>'subject_id' is null or not exists (select 1 from app.subjects where id = (v_x->>'subject_id')::uuid
                                                  and school_id = c.school_id and status = 'active') then
      perform private.fail('VALIDATION_ERROR', 'Every period needs an active subject of this school');
    end if;
    if v_x->>'staff_id' is not null and not exists (select 1 from app.staff where id = (v_x->>'staff_id')::uuid
                                                    and school_id = c.school_id and status = 'active') then
      perform private.fail('VALIDATION_ERROR', 'A teacher in this timetable is not active staff of this school');
    end if;
  end loop;
  if (select count(*) from (select distinct x->>'weekday', x->>'slot_ordinal' from jsonb_array_elements(p_entries) x) d)
     <> jsonb_array_length(p_entries) then
    perform private.fail('VALIDATION_ERROR', 'A period appears twice');
  end if;
  if exists (select 1 from jsonb_array_elements(p_entries) x
              where not exists (select 1 from app.schedule_slots ss where ss.period_schedule_id = p_period_schedule_id
                                  and ss.ordinal = (x->>'slot_ordinal')::int and ss.kind = 'period')) then
    perform private.fail('VALIDATION_ERROR', 'Some entries are on breaks or unknown periods');
  end if;

  if p_version_id is null then
    insert into app.timetable_versions (school_id, academic_year_id, section_id, period_schedule_id, effective_from, created_by)
    values (c.school_id, v_sec.academic_year_id, v_sec.id, p_period_schedule_id, p_effective_from, c.account_id)
    returning id into v_id;
  else
    select * into tv from app.timetable_versions where id = p_version_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Timetable not found'); end if;
    if tv.status <> 'draft' then perform private.fail('VALIDATION_ERROR', 'Only draft timetables can be edited; create a new version'); end if;
    if tv.section_id <> v_sec.id then perform private.fail('VALIDATION_ERROR', 'This draft belongs to another section'); end if;
    if p_expected_version is not null and p_expected_version <> tv.version then
      perform private.fail('CONFLICT', 'Someone else changed this draft. Reload to see it.');
    end if;
    update app.timetable_versions set period_schedule_id = p_period_schedule_id, effective_from = p_effective_from
     where id = tv.id returning id into v_id;
    delete from app.timetable_entries where timetable_version_id = v_id;
  end if;
  insert into app.timetable_entries (school_id, timetable_version_id, weekday, slot_ordinal, subject_id, staff_id)
  select c.school_id, v_id, (x->>'weekday')::smallint, (x->>'slot_ordinal')::smallint, (x->>'subject_id')::uuid,
         (x->>'staff_id')::uuid
    from jsonb_array_elements(p_entries) x;
  return jsonb_build_object('timetable_version_id', v_id,
    'version', (select version from app.timetable_versions where id = v_id),
    'conflicts', private.timetable_conflicts(v_id),
    'unassigned_periods', private.tt_unassigned(v_id),
    'subjects_not_in_class', coalesce((select jsonb_agg(distinct sub.name)
        from jsonb_array_elements(p_entries) x join app.subjects sub on sub.id = (x->>'subject_id')::uuid
       where not exists (select 1 from app.class_subjects cs join app.sections s on s.class_id = cs.class_id
                          where s.id = v_sec.id and cs.academic_year_id = v_sec.academic_year_id
                            and cs.subject_id = sub.id and cs.status = 'active')), '[]'::jsonb));
end $$;

create or replace function private.discard_timetable_draft(p_rev integer, p_version_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; tv app.timetable_versions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into tv from app.timetable_versions where id = p_version_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Timetable not found'); end if;
  if tv.status <> 'draft' then perform private.fail('VALIDATION_ERROR', 'Only drafts can be discarded'); end if;
  if p_expected_version is not null and p_expected_version <> tv.version then
    perform private.fail('CONFLICT', 'Someone else changed this draft. Reload to see it.');
  end if;
  delete from app.timetable_versions where id = tv.id;   -- entries cascade; drafts never produce lessons
  perform private.log_event('timetable.draft.discarded', 'timetable_versions', tv.id::text,
                            jsonb_build_object('section_id', tv.section_id));
  return jsonb_build_object('timetable_version_id', tv.id, 'discarded', true);
end $$;

-- -----------------------------------------------------------------------------
-- Lessons: generate AND refresh. Unused future lessons follow the active plan;
-- lessons with attendance/diary/homework are never changed (reported as kept_used).
-- Manual overrides (source <> 'timetable') are never touched.
-- -----------------------------------------------------------------------------
create or replace function private.lesson_is_used(p_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.student_period_attendance a where a.lesson_session_id = p_id)
      or exists (select 1 from app.diary_entries de where de.lesson_session_id = p_id)
      or exists (select 1 from app.homework_assignments h where h.lesson_session_id = p_id)
$$;

create or replace function private.generate_lesson_sessions(p_rev integer, p_from date, p_to date, p_section_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_today date; v_ins integer; v_upd integer; v_cancel integer; v_tt integer; v_kept jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  if p_from is null or p_to is null then perform private.fail('VALIDATION_ERROR', 'Choose a date range'); end if;
  if p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Generate at most 63 days at a time');
  end if;
  v_today := private.school_today(c.school_id);

  drop table if exists pg_temp.gls_plan;
  create temp table gls_plan on commit drop as
  with days as (
    select d::date as d, r.*
      from generate_series(p_from, p_to, interval '1 day') d
      cross join lateral private.resolve_day(c.school_id, 'student', null, d::date) r
     where r.weight > 0
  )
  select tv.school_id, tv.academic_year_id, tv.section_id, days.d, te.slot_ordinal, ss.label,
         ss.start_time, ss.end_time, te.subject_id, te.staff_id, te.id as entry_id
    from days
    join app.timetable_versions tv
      on tv.school_id = c.school_id and tv.status = 'active'
     and tv.academic_year_id = days.academic_year_id
     and tv.effective_from <= days.d and (tv.effective_to is null or tv.effective_to > days.d)
     and (p_section_id is null or tv.section_id = p_section_id)
    join app.timetable_entries te
      on te.timetable_version_id = tv.id and te.weekday = extract(isodow from days.d)
    join app.schedule_slots ss
      on ss.period_schedule_id = case when days.day_type = 'half_day' then days.period_schedule_id
                                      else coalesce(days.period_schedule_id, tv.period_schedule_id) end
     and ss.ordinal = te.slot_ordinal and ss.kind = 'period';

  insert into app.lesson_sessions (school_id, academic_year_id, section_id, session_date, slot_ordinal, slot_label,
                                   start_time, end_time, subject_id, planned_staff_id, actual_staff_id,
                                   timetable_entry_id, source)
  select school_id, academic_year_id, section_id, d, slot_ordinal, label, start_time, end_time,
         subject_id, staff_id, staff_id, entry_id, 'timetable'
    from pg_temp.gls_plan
  on conflict (section_id, session_date, slot_ordinal) do nothing;
  get diagnostics v_ins = row_count;

  -- lessons that changed in the plan but are already in use: report, never touch
  select coalesce(jsonb_agg(jsonb_build_object('lesson_session_id', ls.id, 'date', ls.session_date,
                    'section_id', ls.section_id, 'slot_ordinal', ls.slot_ordinal) order by ls.session_date, ls.slot_ordinal), '[]')
    into v_kept
    from app.lesson_sessions ls
    left join pg_temp.gls_plan p on p.section_id = ls.section_id and p.d = ls.session_date and p.slot_ordinal = ls.slot_ordinal
   where ls.school_id = c.school_id and ls.source = 'timetable' and ls.status = 'scheduled'
     and ls.session_date between greatest(p_from, v_today) and p_to
     and (p_section_id is null or ls.section_id = p_section_id)
     and coalesce((select weight from private.resolve_day(c.school_id, 'student', null, ls.session_date)), 0) > 0
     and (p.section_id is null
          or (ls.subject_id, ls.planned_staff_id, ls.start_time, ls.end_time)
             is distinct from (p.subject_id, p.staff_id, p.start_time, p.end_time))
     and private.lesson_is_used(ls.id);

  -- refresh unused future lessons to the active plan (also restores ones we auto-cancelled)
  update app.lesson_sessions ls
     set subject_id = p.subject_id, planned_staff_id = p.staff_id,
         actual_staff_id = case when exists (select 1 from app.substitutions s
                                              where s.lesson_session_id = ls.id and s.status = 'active')
                                then ls.actual_staff_id else p.staff_id end,
         slot_label = p.label, start_time = p.start_time, end_time = p.end_time, timetable_entry_id = p.entry_id,
         status = 'scheduled', cancel_reason = null
    from pg_temp.gls_plan p
   where ls.section_id = p.section_id and ls.session_date = p.d and ls.slot_ordinal = p.slot_ordinal
     and ls.school_id = c.school_id and ls.source = 'timetable' and ls.session_date >= v_today
     and (ls.status = 'scheduled' or ls.cancel_reason in ('Calendar: not a working day', 'Timetable changed'))
     and (ls.subject_id, ls.planned_staff_id, ls.slot_label, ls.start_time, ls.end_time, ls.timetable_entry_id, ls.status)
         is distinct from (p.subject_id, p.staff_id, p.label, p.start_time, p.end_time, p.entry_id, 'scheduled')
     and not private.lesson_is_used(ls.id);
  get diagnostics v_upd = row_count;

  -- unused future lessons on working days that the active plan no longer has
  update app.lesson_sessions ls
     set status = 'cancelled', cancel_reason = 'Timetable changed'
   where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.source = 'timetable'
     and ls.session_date between greatest(p_from, v_today) and p_to
     and (p_section_id is null or ls.section_id = p_section_id)
     and coalesce((select weight from private.resolve_day(c.school_id, 'student', null, ls.session_date)), 0) > 0
     and not exists (select 1 from pg_temp.gls_plan p where p.section_id = ls.section_id and p.d = ls.session_date
                       and p.slot_ordinal = ls.slot_ordinal)
     and not private.lesson_is_used(ls.id);
  get diagnostics v_tt = row_count;

  -- unused lessons on dates that became non-working
  update app.lesson_sessions ls
     set status = 'cancelled', cancel_reason = 'Calendar: not a working day'
   where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.source = 'timetable'
     and ls.session_date between p_from and p_to
     and (p_section_id is null or ls.section_id = p_section_id)
     and coalesce((select weight from private.resolve_day(c.school_id, 'student', null, ls.session_date)), 0) = 0
     and not private.lesson_is_used(ls.id);
  get diagnostics v_cancel = row_count;

  perform private.log_event('timetable.sessions.generated', 'lesson_sessions', null,
    jsonb_build_object('from', p_from, 'to', p_to, 'section_id', p_section_id, 'created', v_ins, 'updated', v_upd,
                       'cancelled_timetable', v_tt, 'cancelled_calendar', v_cancel, 'kept_used', jsonb_array_length(v_kept)));
  return jsonb_build_object('created', v_ins, 'updated', v_upd, 'cancelled_unused', v_cancel + v_tt,
                            'cancelled_timetable_changed', v_tt, 'cancelled_not_working', v_cancel, 'kept_used', v_kept);
end $$;

create or replace function private.update_lesson_session(p_rev integer, p_lesson_session_id bigint, p_action text,
                                                         p_subject_id uuid, p_reason text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  if p_expected_version is not null and v_ls.version <> p_expected_version then
    perform private.fail('CONFLICT', 'This lesson changed since you opened it');
  end if;
  if length(p_reason) > 500 then perform private.fail('VALIDATION_ERROR', 'Reason can be at most 500 characters'); end if;
  if p_action = 'cancel' then
    if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
    if v_ls.status = 'cancelled' then perform private.fail('VALIDATION_ERROR', 'This lesson is already cancelled'); end if;
    update app.lesson_sessions set status = 'cancelled', cancel_reason = p_reason where id = v_ls.id;
  elsif p_action = 'restore' then
    if v_ls.status = 'scheduled' then perform private.fail('VALIDATION_ERROR', 'This lesson is not cancelled'); end if;
    if coalesce((select weight from private.resolve_day(c.school_id, 'student', null, v_ls.session_date)), 0) = 0 then
      perform private.fail('VALIDATION_ERROR', 'That date is not a working day; change the calendar first');
    end if;
    update app.lesson_sessions set status = 'scheduled', cancel_reason = null where id = v_ls.id;
  elsif p_action = 'change_subject' then
    if p_subject_id is null or not exists (
         select 1 from app.class_subjects cs join app.sections s on s.class_id = cs.class_id
          where s.id = v_ls.section_id and cs.academic_year_id = v_ls.academic_year_id
            and cs.subject_id = p_subject_id and cs.status = 'active') then
      perform private.fail('VALIDATION_ERROR', 'Choose a subject taught in this class');
    end if;
    if private.lesson_is_used(v_ls.id) then
      perform private.fail('VALIDATION_ERROR', 'Attendance, diary or homework is already recorded for this lesson, so its subject can''t change');
    end if;
    update app.lesson_sessions set subject_id = p_subject_id, source = 'override' where id = v_ls.id;
  else
    perform private.fail('VALIDATION_ERROR', 'Unknown action');
  end if;
  perform private.log_event('timetable.lesson.' || p_action, 'lesson_sessions', v_ls.id::text,
                            jsonb_build_object('reason', p_reason, 'subject_id', p_subject_id));
  return jsonb_build_object('lesson_session_id', v_ls.id,
                            'version', (select version from app.lesson_sessions where id = v_ls.id));
end $$;

create or replace function private.get_schedule_range(p_rev integer, p_from date, p_to date, p_section_id uuid, p_staff_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 6 then
    perform private.fail('LIMIT_REACHED', 'Choose up to 7 days');
  end if;
  return (select jsonb_agg(jsonb_build_object('date', d::date,
            'day', (select to_jsonb(r) from private.resolve_day(c.school_id, 'student', null, d::date) r),
            'lessons', private.get_date_schedule(p_rev, d::date, p_section_id, p_staff_id)) order by d)
            from generate_series(p_from, p_to, interval '1 day') d);
end $$;

create or replace function private.list_substitutions(p_rev integer, p_from date, p_to date, p_staff_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.read_all');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Choose up to 63 days');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'substitution_id', s.id, 'lesson_session_id', ls.id, 'date', ls.session_date, 'slot_label', ls.slot_label,
      'start_time', ls.start_time, 'section', cl.name || ' ' || sec.name, 'subject', sub.name,
      'original_staff_id', s.original_staff_id, 'original_staff', os.full_name,
      'substitute_staff_id', s.substitute_staff_id, 'substitute_staff', ss.full_name,
      'reason', s.reason, 'conflict_override_reason', s.conflict_override_reason, 'status', s.status,
      'assigned_by', (select display_name from app.accounts where id = s.assigned_by), 'assigned_at', s.assigned_at,
      'ended_by', (select display_name from app.accounts where id = s.ended_by), 'ended_at', s.ended_at)
      order by ls.session_date desc, ls.start_time, s.assigned_at)
    from app.substitutions s
    join app.lesson_sessions ls on ls.id = s.lesson_session_id
    join app.sections sec on sec.id = ls.section_id join app.classes cl on cl.id = sec.class_id
    join app.subjects sub on sub.id = ls.subject_id
    left join app.staff os on os.id = s.original_staff_id
    join app.staff ss on ss.id = s.substitute_staff_id
   where s.school_id = c.school_id and ls.session_date between p_from and p_to
     and (p_staff_id is null or s.substitute_staff_id = p_staff_id or s.original_staff_id = p_staff_id)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Staff attendance roster (current marks + versions; null = Unmarked)
-- -----------------------------------------------------------------------------
create or replace function private.get_staff_attendance(p_rev integer, p_date date, p_staff_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_attendance.read');
  if p_date is null then perform private.fail('VALIDATION_ERROR', 'Choose a date'); end if;
  return jsonb_build_object('date', p_date, 'can_mark', private.has_cap('staff_attendance.manage'),
    'is_future', p_date > private.school_today(c.school_id),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
        'staff_id', s.id, 'employee_no', s.employee_no, 'name', s.full_name, 'staff_group_id', g.id, 'group', g.name,
        'is_teaching', s.is_teaching,
        'day', (select jsonb_build_object('day_type', r.day_type, 'weight', r.weight, 'label', r.label)
                  from private.resolve_day(c.school_id, 'staff', g.id, p_date) r),
        'status', sa.status, 'version', sa.version,
        'paid_leave', (select pl.day_fraction from app.staff_paid_leave pl
                        where pl.staff_id = s.id and pl.leave_date = p_date and pl.status = 'active'))
        order by g.name, s.full_name)
      from app.staff s join app.staff_groups g on g.id = s.staff_group_id
      left join app.staff_attendance sa on sa.staff_id = s.id and sa.attendance_date = p_date
     where s.school_id = c.school_id and s.joined_on <= p_date and (s.left_on is null or s.left_on >= p_date)
       and (s.status = 'active' or sa.status is not null)
       and (p_staff_group_id is null or s.staff_group_id = p_staff_group_id)), '[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Diary reads
-- -----------------------------------------------------------------------------
create or replace function private.can_read_lesson(p_role text, p_staff uuid, p_ls app.lesson_sessions)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_cap('academic.read_all')
      or (p_role = 'teacher' and (p_staff = p_ls.actual_staff_id or p_staff = p_ls.planned_staff_id
                                  or p_ls.section_id in (select private.teacher_section_ids())))
      or exists (select 1 from private.child_section_windows() w
                  where w.section_id = p_ls.section_id and w.from_date <= p_ls.session_date
                    and (w.to_date is null or w.to_date > p_ls.session_date))
$$;

create or replace function private.get_diary_entry(p_rev integer, p_lesson_session_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_de app.diary_entries;
begin
  select * into c from private.require_ctx(p_rev);
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  if not private.can_read_lesson(c.role, c.staff_id, v_ls) then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
  select * into v_de from app.diary_entries where lesson_session_id = v_ls.id;
  return jsonb_build_object(
    'lesson', jsonb_build_object('lesson_session_id', v_ls.id, 'date', v_ls.session_date, 'slot_label', v_ls.slot_label,
       'start_time', v_ls.start_time, 'end_time', v_ls.end_time, 'section_id', v_ls.section_id,
       'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = v_ls.section_id),
       'subject', (select name from app.subjects where id = v_ls.subject_id),
       'teacher', (select full_name from app.staff where id = v_ls.actual_staff_id), 'status', v_ls.status),
    'entry', case when v_de.id is null then null else jsonb_build_object('diary_entry_id', v_de.id, 'body', v_de.body,
       'version', v_de.version, 'recorded_by_staff', (select full_name from app.staff where id = v_de.recorded_by_staff),
       'created_at', v_de.created_at, 'updated_at', v_de.updated_at) end,
    'can_edit', private.can_teach_lesson(c.role, c.staff_id, v_ls) and v_ls.status = 'scheduled'
                and v_ls.session_date <= private.school_today(c.school_id));
end $$;

-- Lessons (with or without a diary entry) for a section/teacher over ≤63 days. Keyset: (date, id) descending.
create or replace function private.list_diary_entries(p_rev integer, p_section_id uuid, p_staff_id uuid, p_from date, p_to date,
                                                      p_only_missing boolean, p_before_date date, p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_items jsonb; v_to date;
begin
  select * into c from private.require_ctx(p_rev);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Choose up to 63 days');
  end if;
  if (p_before_date is null) <> (p_before_id is null) then
    perform private.fail('VALIDATION_ERROR', 'Pass both cursor values, or neither');
  end if;
  if not private.has_cap('academic.read_all') then
    if c.role <> 'teacher' or c.staff_id is null then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
    if p_staff_id is not null and p_staff_id <> c.staff_id then perform private.fail('FORBIDDEN', 'You can only list your own lessons'); end if;
    if p_section_id is not null and p_section_id not in (select private.teacher_section_ids()) then
      perform private.fail('FORBIDDEN', 'You don''t teach this section');
    end if;
    if p_section_id is null then p_staff_id := c.staff_id; end if;
  end if;
  v_to := least(p_to, private.school_today(c.school_id));
  select coalesce(jsonb_agg(x order by (x->>'date') desc, (x->>'lesson_session_id')::bigint desc), '[]') into v_items from (
    select jsonb_build_object('lesson_session_id', ls.id, 'date', ls.session_date, 'slot_label', ls.slot_label,
             'start_time', ls.start_time, 'section_id', ls.section_id, 'section', cl.name || ' ' || sec.name,
             'subject', sub.name, 'teacher_id', ls.actual_staff_id, 'teacher', st.full_name,
             'diary_entry_id', de.id, 'body', de.body, 'version', de.version, 'updated_at', de.updated_at) as x
      from app.lesson_sessions ls
      join app.sections sec on sec.id = ls.section_id join app.classes cl on cl.id = sec.class_id
      join app.subjects sub on sub.id = ls.subject_id
      left join app.staff st on st.id = ls.actual_staff_id
      left join app.diary_entries de on de.lesson_session_id = ls.id
     where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.session_date between p_from and v_to
       and (p_section_id is null or ls.section_id = p_section_id)
       and (p_staff_id is null or ls.actual_staff_id = p_staff_id)
       and (not coalesce(p_only_missing, false) or de.id is null)
       and (p_before_date is null or (ls.session_date, ls.id) < (p_before_date, p_before_id))
     order by ls.session_date desc, ls.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_date', v_items->-1->>'date', 'before_id', (v_items->-1->>'lesson_session_id')::bigint) end);
end $$;

-- Parent / student (and staff who may see the student): diary notes of the child's lessons
create or replace function private.get_student_diary(p_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if not private.can_view_student(p_student_id, 'academic.read_all') then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Choose up to 63 days');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('lesson_session_id', ls.id, 'date', ls.session_date,
             'slot_label', ls.slot_label, 'start_time', ls.start_time, 'subject', sub.name, 'teacher', st.full_name,
             'body', de.body, 'updated_at', de.updated_at) order by ls.session_date desc, ls.start_time)
    from app.lesson_sessions ls
    join app.diary_entries de on de.lesson_session_id = ls.id
    join app.subjects sub on sub.id = ls.subject_id
    left join app.staff st on st.id = ls.actual_staff_id
   where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.session_date between p_from and p_to
     and exists (select 1 from app.placements p join app.enrollments e on e.id = p.enrollment_id
                  where p.student_id = p_student_id and p.section_id = ls.section_id
                    and p.effective_from <= ls.session_date and (p.effective_to is null or p.effective_to > ls.session_date)
                    and e.joined_on <= ls.session_date and (e.left_on is null or e.left_on >= ls.session_date))), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Homework
-- -----------------------------------------------------------------------------
create or replace function private.save_homework(p_rev integer, p_assignment_id uuid, p_lesson_session_id bigint,
                                                 p_due_on date, p_description text, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_hw app.homework_assignments;
begin
  select * into c from private.require_ctx(p_rev);
  if p_description is not null and length(btrim(p_description)) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Describe the homework');
  end if;
  if length(p_description) > 4000 then perform private.fail('VALIDATION_ERROR', 'Description can be at most 4000 characters'); end if;
  if p_status is not null and p_status not in ('active','cancelled') then
    perform private.fail('VALIDATION_ERROR', 'Status must be active or cancelled');
  end if;
  if p_assignment_id is null then
    select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
    if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
    if not private.can_teach_lesson(c.role, c.staff_id, v_ls) then
      perform private.fail('FORBIDDEN', 'Only the teacher who took this lesson (or Admin) can set its homework');
    end if;
    if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'Lesson was cancelled'); end if;
    if p_description is null then perform private.fail('VALIDATION_ERROR', 'Describe the homework'); end if;
    if p_due_on is null then perform private.fail('VALIDATION_ERROR', 'Choose a due date'); end if;
    if p_due_on < v_ls.session_date then perform private.fail('VALIDATION_ERROR', 'Due date can''t be before the lesson date'); end if;
    insert into app.homework_assignments (school_id, academic_year_id, section_id, subject_id, lesson_session_id,
                                          assigned_by_staff, assigned_on, due_on, description, created_by)
    values (c.school_id, v_ls.academic_year_id, v_ls.section_id, v_ls.subject_id, v_ls.id,
            case when c.role = 'teacher' then c.staff_id else v_ls.actual_staff_id end,
            v_ls.session_date, p_due_on, btrim(p_description), c.account_id)
    returning * into v_hw;
  else
    select * into v_hw from app.homework_assignments where id = p_assignment_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Homework not found'); end if;
    if not (private.has_cap('academic.correct') or (c.role = 'teacher' and c.staff_id = v_hw.assigned_by_staff)) then
      perform private.fail('FORBIDDEN', 'Only the assigning teacher (or Admin) can edit this homework');
    end if;
    if p_expected_version is null or p_expected_version <> v_hw.version then
      perform private.fail('CONFLICT', 'This homework changed since you opened it');
    end if;
    if p_due_on is not null and p_due_on < v_hw.assigned_on then
      perform private.fail('VALIDATION_ERROR', 'Due date can''t be before the assigned date');
    end if;
    update app.homework_assignments
       set due_on = coalesce(p_due_on, due_on), description = coalesce(btrim(p_description), description),
           status = coalesce(p_status, status)
     where id = v_hw.id returning * into v_hw;
  end if;
  return jsonb_build_object('assignment_id', v_hw.id, 'version', v_hw.version);
end $$;

-- Homework list with check progress. Teachers see sections they teach (or homework they set).
-- Keyset: (assigned_on, id) descending.
create or replace function private.list_homework(p_rev integer, p_section_id uuid, p_subject_id uuid, p_staff_id uuid,
                                                 p_from date, p_to date, p_status text, p_before_date date, p_before_id uuid,
                                                 p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_items jsonb; v_all boolean;
begin
  select * into c from private.require_ctx(p_rev);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('LIMIT_REACHED', 'Choose a range up to 400 days');
  end if;
  if (p_before_date is null) <> (p_before_id is null) then
    perform private.fail('VALIDATION_ERROR', 'Pass both cursor values, or neither');
  end if;
  if coalesce(p_status, 'active') not in ('active','cancelled','all') then perform private.fail('VALIDATION_ERROR', 'Unknown status'); end if;
  v_all := private.has_cap('academic.read_all');
  if not v_all and (c.role <> 'teacher' or c.staff_id is null) then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
  if not v_all and p_section_id is not null and p_section_id not in (select private.teacher_section_ids()) then
    perform private.fail('FORBIDDEN', 'You don''t teach this section');
  end if;
  select coalesce(jsonb_agg(x order by (x->>'assigned_on') desc, x->>'assignment_id' desc), '[]') into v_items from (
    select jsonb_build_object('assignment_id', ha.id, 'section_id', ha.section_id, 'section', cl.name || ' ' || sec.name,
             'subject_id', ha.subject_id, 'subject', sub.name, 'assigned_by_staff', ha.assigned_by_staff, 'assigned_by', st.full_name,
             'lesson_session_id', ha.lesson_session_id, 'assigned_on', ha.assigned_on, 'due_on', ha.due_on,
             'description', ha.description, 'status', ha.status, 'version', ha.version,
             'eligible', (select count(*) from private.eligible_students(ha.section_id, ha.assigned_on)),
             'checked', (select count(*) from app.homework_checks hc where hc.assignment_id = ha.id),
             'completed', (select count(*) from app.homework_checks hc where hc.assignment_id = ha.id and hc.completion = 'completed'),
             'not_completed', (select count(*) from app.homework_checks hc where hc.assignment_id = ha.id and hc.completion = 'not_completed'),
             'correction_required', (select count(*) from app.homework_checks hc where hc.assignment_id = ha.id and hc.correction = 'required'),
             'can_edit', private.has_cap('academic.correct') or (c.role = 'teacher' and c.staff_id = ha.assigned_by_staff),
             'can_check', private.can_check_homework(c.role, c.staff_id, ha, private.school_today(c.school_id))) as x
      from app.homework_assignments ha
      join app.sections sec on sec.id = ha.section_id join app.classes cl on cl.id = sec.class_id
      join app.subjects sub on sub.id = ha.subject_id
      left join app.staff st on st.id = ha.assigned_by_staff
     where ha.school_id = c.school_id and ha.assigned_on between p_from and p_to
       and (coalesce(p_status, 'active') = 'all' or ha.status = coalesce(p_status, 'active'))
       and (p_section_id is null or ha.section_id = p_section_id)
       and (p_subject_id is null or ha.subject_id = p_subject_id)
       and (p_staff_id is null or ha.assigned_by_staff = p_staff_id)
       and (v_all or ha.section_id in (select private.teacher_section_ids()) or ha.assigned_by_staff = c.staff_id)
       and (p_before_date is null or (ha.assigned_on, ha.id) < (p_before_date, p_before_id))
     order by ha.assigned_on desc, ha.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit
                        then jsonb_build_object('before_date', v_items->-1->>'assigned_on', 'before_id', v_items->-1->>'assignment_id') end);
end $$;

create or replace function private.get_student_homework(p_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if not private.can_view_student(p_student_id, 'academic.read_all') then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('LIMIT_REACHED', 'Choose a range up to 400 days');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', ha.id, 'subject', sub.name, 'assigned_by', st.full_name,
      'assigned_on', ha.assigned_on, 'due_on', ha.due_on, 'description', ha.description,
      'state', case when hc.id is null then 'unchecked' else hc.completion end,
      'correction', hc.correction, 'observed_on', hc.observed_on, 'completed_on', hc.completed_on,
      'completed_after_due', case when hc.completed_on is not null then hc.completed_on > ha.due_on end,
      'observed_after_due', case when hc.completion = 'completed' and hc.completed_on is null then hc.observed_on > ha.due_on end,
      'comment', hc.comment) order by ha.assigned_on desc, ha.id)
    from app.homework_assignments ha
    join app.subjects sub on sub.id = ha.subject_id
    left join app.staff st on st.id = ha.assigned_by_staff
    left join app.homework_checks hc on hc.assignment_id = ha.id and hc.student_id = p_student_id
   where ha.school_id = c.school_id and ha.status = 'active' and ha.assigned_on between p_from and p_to
     and exists (select 1 from app.placements p join app.enrollments e on e.id = p.enrollment_id
                  where p.student_id = p_student_id and p.section_id = ha.section_id
                    and ha.assigned_on >= greatest(p.effective_from, e.joined_on)
                    and (p.effective_to is null or ha.assigned_on < p.effective_to))), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Per-day / per-lesson attendance records for one student (≤63 days)
-- -----------------------------------------------------------------------------
create or replace function private.get_student_attendance_records(p_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_to date;
begin
  select * into c from private.require_ctx(p_rev);
  if not private.can_view_student(p_student_id, 'attendance.read_all') then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Choose up to 63 days');
  end if;
  v_to := least(p_to, private.school_today(c.school_id));
  if v_to < p_from then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', q.d, 'mode', q.mode, 'day_type', q.day_type, 'weight', q.weight, 'section_id', q.section_id,
      'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = q.section_id),
      'status', case when q.mode = 'daily' and q.weight > 0 then
                  (select a.status from app.student_daily_attendance a where a.student_id = p_student_id and a.attendance_date = q.d) end,
      'lessons', case when q.mode = 'period' then coalesce((
                  select jsonb_agg(jsonb_build_object('lesson_session_id', ls.id, 'slot_label', ls.slot_label,
                           'start_time', ls.start_time, 'subject', sub.name, 'teacher', st.full_name,
                           'lesson_status', ls.status, 'status', pa.status) order by ls.start_time)
                    from app.lesson_sessions ls join app.subjects sub on sub.id = ls.subject_id
                    left join app.staff st on st.id = ls.actual_staff_id
                    left join app.student_period_attendance pa on pa.lesson_session_id = ls.id and pa.student_id = p_student_id
                   where ls.section_id = q.section_id and ls.session_date = q.d), '[]'::jsonb) end)
      order by q.d desc)
    from (
      select d::date as d, p.section_id, private.attendance_mode_on(c.school_id, d::date) as mode,
             r.day_type, coalesce(r.weight, 0) as weight
        from generate_series(p_from, v_to, interval '1 day') d
        join app.placements p on p.student_id = p_student_id and p.effective_from <= d::date
                             and (p.effective_to is null or p.effective_to > d::date)
        join app.enrollments e on e.id = p.enrollment_id and e.joined_on <= d::date and (e.left_on is null or e.left_on >= d::date)
        left join lateral private.resolve_day(c.school_id, 'student', null, d::date) r on true) q), '[]'::jsonb);
end $$;

-- Public wrappers
create or replace function public.get_timetable_version(p_ctx_rev integer, p_version_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_timetable_version(p_ctx_rev, p_version_id) $$;
create or replace function public.list_timetable_versions(p_ctx_rev integer, p_section_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_timetable_versions(p_ctx_rev, p_section_id) $$;
create or replace function public.save_timetable_draft(p_ctx_rev integer, p_section_id uuid, p_period_schedule_id uuid, p_effective_from date, p_entries jsonb, p_version_id uuid default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_timetable_draft(p_ctx_rev, p_section_id, p_period_schedule_id, p_effective_from, p_entries, p_version_id, p_expected_version) $$;
create or replace function public.discard_timetable_draft(p_ctx_rev integer, p_version_id uuid, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.discard_timetable_draft(p_ctx_rev, p_version_id, p_expected_version) $$;
create or replace function public.get_schedule_range(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null, p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_schedule_range(p_ctx_rev, p_from, p_to, p_section_id, p_staff_id) $$;
create or replace function public.list_substitutions(p_ctx_rev integer, p_from date, p_to date, p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_substitutions(p_ctx_rev, p_from, p_to, p_staff_id) $$;
create or replace function public.get_staff_attendance(p_ctx_rev integer, p_date date, p_staff_group_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_staff_attendance(p_ctx_rev, p_date, p_staff_group_id) $$;
create or replace function public.get_diary_entry(p_ctx_rev integer, p_lesson_session_id bigint)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_diary_entry(p_ctx_rev, p_lesson_session_id) $$;
create or replace function public.list_diary_entries(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null, p_staff_id uuid default null, p_only_missing boolean default false, p_before_date date default null, p_before_id bigint default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_diary_entries(p_ctx_rev, p_section_id, p_staff_id, p_from, p_to, p_only_missing, p_before_date, p_before_id, p_limit) $$;
create or replace function public.get_student_diary(p_ctx_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_student_diary(p_ctx_rev, p_student_id, p_from, p_to) $$;
create or replace function public.list_homework(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null, p_subject_id uuid default null, p_staff_id uuid default null, p_status text default 'active', p_before_date date default null, p_before_id uuid default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_homework(p_ctx_rev, p_section_id, p_subject_id, p_staff_id, p_from, p_to, p_status, p_before_date, p_before_id, p_limit) $$;
create or replace function public.get_student_attendance_records(p_ctx_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_student_attendance_records(p_ctx_rev, p_student_id, p_from, p_to) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.tt_weekdays(uuid, uuid), private.tt_unassigned(uuid), private.list_timetable_versions(integer, uuid),
  private.get_timetable_version(integer, uuid), private.save_timetable_draft(integer, uuid, uuid, date, jsonb, uuid, integer),
  private.discard_timetable_draft(integer, uuid, integer), private.lesson_is_used(bigint),
  private.get_schedule_range(integer, date, date, uuid, uuid), private.list_substitutions(integer, date, date, uuid),
  private.get_staff_attendance(integer, date, uuid), private.can_read_lesson(text, uuid, app.lesson_sessions),
  private.get_diary_entry(integer, bigint),
  private.list_diary_entries(integer, uuid, uuid, date, date, boolean, date, bigint, integer),
  private.get_student_diary(integer, uuid, date, date),
  private.list_homework(integer, uuid, uuid, uuid, date, date, text, date, uuid, integer),
  private.get_student_attendance_records(integer, uuid, date, date)
to authenticated;
grant execute on function
  public.get_timetable_version(integer, uuid), 
  public.list_timetable_versions(integer, uuid), 
  public.save_timetable_draft(integer, uuid, uuid, date, jsonb, uuid, integer), 
  public.discard_timetable_draft(integer, uuid, integer), 
  public.get_schedule_range(integer, date, date, uuid, uuid), 
  public.list_substitutions(integer, date, date, uuid), 
  public.get_staff_attendance(integer, date, uuid), 
  public.get_diary_entry(integer, bigint), 
  public.list_diary_entries(integer, date, date, uuid, uuid, boolean, date, bigint, integer), 
  public.get_student_diary(integer, uuid, date, date), 
  public.list_homework(integer, date, date, uuid, uuid, uuid, text, date, uuid, integer), 
  public.get_student_attendance_records(integer, uuid, date, date),
  public.get_teacher_today(integer, date)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
