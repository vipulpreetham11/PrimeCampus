-- =============================================================================
-- PrimeCampus V1 — 1000 Academic operations RPCs
-- Lessons & substitutions (PRD §9), student/staff attendance (PRD §10, §13),
-- diary & homework (PRD §11), placement moves (PRD SIS-02)
-- =============================================================================

-- Students eligible on a date for a section: placed that day, joined, active.
create or replace function private.eligible_students(p_section_id uuid, p_date date)
returns table (student_id uuid, roll_no text, full_name text, admission_no text)
language sql stable security definer set search_path = '' as $$
  select st.id, p.roll_no, st.full_name, st.admission_no
    from app.placements p
    join app.enrollments e on e.id = p.enrollment_id
    join app.students st on st.id = p.student_id
   where p.section_id = p_section_id
     and p.effective_from <= p_date and (p.effective_to is null or p.effective_to > p_date)
     and e.joined_on <= p_date and (e.left_on is null or e.left_on >= p_date)
     and e.status = 'active' and st.status = 'active'
$$;

create or replace function private.is_class_teacher(p_staff_id uuid, p_section_id uuid, p_date date)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.teaching_assignments
                  where staff_id = p_staff_id and section_id = p_section_id and kind = 'class_teacher'
                    and effective_from <= p_date and (effective_to is null or effective_to > p_date))
$$;

create or replace function private.is_subject_teacher(p_staff_id uuid, p_section_id uuid, p_subject_id uuid, p_date date)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.teaching_assignments
                  where staff_id = p_staff_id and section_id = p_section_id and kind = 'subject'
                    and subject_id = p_subject_id
                    and effective_from <= p_date and (effective_to is null or effective_to > p_date))
$$;

-- Can the current context see this student's academic records?
create or replace function private.can_view_student(p_student_id uuid, p_cap text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.students s where s.id = p_student_id and s.school_id = private.ctx_school_id())
     and (private.has_cap(p_cap) or p_student_id in (select private.scoped_student_ids()))
$$;

-- =============================================================================
-- Lessons
-- =============================================================================

-- Materialise dated lessons from active timetable versions + student calendar.
-- Idempotent. Lessons already used (attendance/diary/homework) are never removed;
-- unused lessons on dates that became non-working are cancelled with a reason.
create or replace function private.generate_lesson_sessions(p_rev integer, p_from date, p_to date, p_section_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ins integer; v_cancel integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  if p_to < p_from or p_to - p_from > 62 then
    perform private.fail('LIMIT_REACHED', 'Generate at most 63 days at a time');
  end if;

  with days as (
    select d::date as d, r.*
      from generate_series(p_from, p_to, interval '1 day') d
      cross join lateral private.resolve_day(c.school_id, 'student', null, d::date) r
     where r.weight > 0
  ), plan as (
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
       and ss.ordinal = te.slot_ordinal and ss.kind = 'period'
  )
  insert into app.lesson_sessions (school_id, academic_year_id, section_id, session_date, slot_ordinal, slot_label,
                                   start_time, end_time, subject_id, planned_staff_id, actual_staff_id,
                                   timetable_entry_id, source)
  select school_id, academic_year_id, section_id, d, slot_ordinal, label, start_time, end_time,
         subject_id, staff_id, staff_id, entry_id, 'timetable'
    from plan
  on conflict (section_id, session_date, slot_ordinal) do nothing;
  get diagnostics v_ins = row_count;

  update app.lesson_sessions ls
     set status = 'cancelled', cancel_reason = 'Calendar: not a working day'
   where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.source = 'timetable'
     and ls.session_date between p_from and p_to
     and (p_section_id is null or ls.section_id = p_section_id)
     and (select weight from private.resolve_day(c.school_id, 'student', null, ls.session_date)) = 0
     and not exists (select 1 from app.student_period_attendance a where a.lesson_session_id = ls.id)
     and not exists (select 1 from app.diary_entries de where de.lesson_session_id = ls.id)
     and not exists (select 1 from app.homework_assignments h where h.lesson_session_id = ls.id);
  get diagnostics v_cancel = row_count;

  perform private.log_event('timetable.sessions.generated', 'lesson_sessions', null,
    jsonb_build_object('from', p_from, 'to', p_to, 'section_id', p_section_id, 'created', v_ins, 'cancelled', v_cancel));
  return jsonb_build_object('created', v_ins, 'cancelled_unused', v_cancel);
end $$;

-- Date view: actual lessons with planned vs actual teacher, absence flags, substitution
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

-- Cancel / restore / override one dated lesson without touching the weekly plan
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
  if p_action = 'cancel' then
    if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
    update app.lesson_sessions set status = 'cancelled', cancel_reason = p_reason where id = v_ls.id;
  elsif p_action = 'restore' then
    update app.lesson_sessions set status = 'scheduled', cancel_reason = null where id = v_ls.id;
  elsif p_action = 'change_subject' then
    if not exists (select 1 from app.subjects where id = p_subject_id and school_id = c.school_id) then
      perform private.fail('VALIDATION_ERROR', 'Unknown subject');
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

-- Availability: present / absent / unmarked (never "confirmed free" when unknown)
create or replace function private.suggest_substitutes(p_rev integer, p_lesson_session_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'has_conflict')::boolean, x->>'availability' <> 'present', x->>'name')
    from (
      select jsonb_build_object(
        'staff_id', s.id, 'name', s.full_name,
        'availability', case sa.status when 'A' then 'absent' when 'H' then 'half_day'
                                       when 'P' then 'present' when 'L' then 'present' else 'unmarked' end,
        'has_conflict', exists (select 1 from app.lesson_sessions o
                                 where o.actual_staff_id = s.id and o.session_date = v_ls.session_date
                                   and o.status = 'scheduled' and o.id <> v_ls.id
                                   and o.start_time < v_ls.end_time and o.end_time > v_ls.start_time),
        'teaches_subject_in_section', private.is_subject_teacher(s.id, v_ls.section_id, v_ls.subject_id, v_ls.session_date)
      ) as x
      from app.staff s
      left join app.staff_attendance sa on sa.staff_id = s.id and sa.attendance_date = v_ls.session_date
     where s.school_id = c.school_id and s.status = 'active' and s.is_teaching
       and s.id is distinct from v_ls.planned_staff_id
       and s.joined_on <= v_ls.session_date and (s.left_on is null or s.left_on >= v_ls.session_date)
    ) q), '[]'::jsonb);
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
  if not exists (select 1 from app.staff where id = p_staff_id and school_id = c.school_id and status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Substitute must be active staff of this school');
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
  return jsonb_build_object('substitution_id', v_id, 'lesson_session_id', v_ls.id,
                            'conflict_overridden', v_conflict or v_absent);
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
  return jsonb_build_object('lesson_session_id', v_ls.id);
end $$;

-- =============================================================================
-- Student attendance
-- =============================================================================

-- Roster for marking: eligible students with current mark + version (null = Unmarked)
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

-- Save marks for one roster (≤100). Only the listed students change; others untouched.
-- p_marks: [{student_id, status, expected_version}] — expected_version null means
-- "I believe this student is Unmarked". Stale entries come back as conflicts.
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
    if (select weight from private.resolve_day(c.school_id, 'student', null, p_date)) = 0 then
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

-- Attendance figures for a student over a range (PRD ATT-02, TRD §10.3).
-- Never labels a percentage final while any eligible unit is unmarked.
create or replace function private.get_student_attendance_summary(p_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_to date; r record;
begin
  select * into c from private.require_ctx(p_rev);
  if not (private.can_view_student(p_student_id, 'attendance.read_all')
          or (private.has_cap('attendance.summary')
              and exists (select 1 from app.students where id = p_student_id and school_id = c.school_id))) then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  if p_to - p_from > 400 then perform private.fail('LIMIT_REACHED', 'Range too long'); end if;
  v_to := least(p_to, private.school_today(c.school_id));

  with dates as (
    select d::date as d from generate_series(p_from, v_to, interval '1 day') d
  ), placed as (
    select dates.d, p.section_id
      from dates
      join app.placements p on p.student_id = p_student_id and p.effective_from <= dates.d
                           and (p.effective_to is null or p.effective_to > dates.d)
      join app.enrollments e on e.id = p.enrollment_id and e.joined_on <= dates.d
                            and (e.left_on is null or e.left_on >= dates.d)
  ), moded as (
    select placed.*, private.attendance_mode_on(c.school_id, placed.d) as mode,
           (select weight from private.resolve_day(c.school_id, 'student', null, placed.d)) as weight
      from placed
  ), units as (
    -- daily mode: one unit per eligible working/half day
    select 'daily' as mode, m.d, null::bigint as ls_id,
           case a.status when 'P' then 1.0 when 'L' then 1.0 when 'H' then 0.5 when 'A' then 0 end as score
      from moded m
      left join app.student_daily_attendance a on a.student_id = p_student_id and a.attendance_date = m.d
     where m.mode = 'daily' and m.weight > 0
    union all
    -- period mode: one unit per scheduled (not cancelled) lesson of the placed section
    select 'period', m.d, ls.id,
           case pa.status when 'P' then 1.0 when 'L' then 1.0 when 'A' then 0 end
      from moded m
      join app.lesson_sessions ls on ls.section_id = m.section_id and ls.session_date = m.d and ls.status = 'scheduled'
      left join app.student_period_attendance pa on pa.lesson_session_id = ls.id and pa.student_id = p_student_id
     where m.mode = 'period'
  )
  select count(*) as expected_units,
         count(score) as marked_units,
         coalesce(sum(score), 0) as attended_units,
         count(*) - count(score) as unmarked_units,
         count(*) filter (where mode = 'daily') as daily_units,
         count(*) filter (where mode = 'period') as period_units
    into r from units;

  return jsonb_build_object(
    'student_id', p_student_id, 'from', p_from, 'to', v_to,
    'expected_units', r.expected_units, 'marked_units', r.marked_units,
    'attended_units', r.attended_units, 'unmarked_units', r.unmarked_units,
    'daily_units', r.daily_units, 'period_units', r.period_units,
    'marking_coverage_pct', case when r.expected_units > 0 then round(100.0 * r.marked_units / r.expected_units, 1) end,
    'percentage', case when r.marked_units > 0 then round(100.0 * r.attended_units / r.marked_units, 1) end,
    'is_final', r.expected_units > 0 and r.unmarked_units = 0,
    'percentage_basis', case when r.unmarked_units = 0 then 'final' else 'provisional_marked_only' end);
end $$;

-- Section marking coverage for a date (Admin / Principal / Owner dashboards)
create or replace function private.get_attendance_overview(p_rev integer, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_mode text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('attendance.summary');
  v_mode := private.attendance_mode_on(c.school_id, p_date);
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
                         then (select count(*) from private.eligible_students(sec.id, p_date))
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

-- =============================================================================
-- Staff attendance (Admin only; Principal reads)
-- =============================================================================
create or replace function private.mark_staff_attendance(p_rev integer, p_operation_id uuid, p_date date, p_marks jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_sub bigint; v_fp text; v_prev jsonb; m jsonb; v_old record; v_ok integer;
        v_marked integer := 0; v_changed integer := 0; v_conflicts jsonb := '[]';
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_attendance.manage');
  if jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) not between 1 and 200 then
    perform private.fail('VALIDATION_ERROR', 'Supply 1–200 marks');
  end if;
  if p_date > private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'Cannot mark a future date');
  end if;
  v_fp := private.fingerprint(jsonb_build_object('d', p_date, 'm', p_marks));
  v_prev := private.idem_lookup(c.school_id, 'staff_attendance.mark', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;
  if exists (select 1 from jsonb_array_elements(p_marks) x
              left join app.staff s on s.id = (x->>'staff_id')::uuid and s.school_id = c.school_id
                                    and s.joined_on <= p_date and (s.left_on is null or s.left_on >= p_date)
             where s.id is null or x->>'status' not in ('P','L','H','A')) then
    perform private.fail('VALIDATION_ERROR', 'Unknown staff, not employed on that date, or invalid status');
  end if;

  insert into app.attendance_submissions (school_id, kind, attendance_date, actor_id, actor_role, operation_id)
  values (c.school_id, 'staff', p_date, c.account_id, c.role, p_operation_id) returning id into v_sub;

  for m in select x from jsonb_array_elements(p_marks) x order by x->>'staff_id' loop
    insert into app.staff_attendance (staff_id, attendance_date, school_id, status, submission_id)
    values ((m->>'staff_id')::uuid, p_date, c.school_id, m->>'status', v_sub)
    on conflict (staff_id, attendance_date) do nothing;
    get diagnostics v_ok = row_count;
    if v_ok > 0 then v_marked := v_marked + 1; continue; end if;
    select status, version into v_old from app.staff_attendance
     where staff_id = (m->>'staff_id')::uuid and attendance_date = p_date for update;
    if v_old.status = m->>'status' then continue; end if;
    if (m->>'expected_version') is null or (m->>'expected_version')::integer <> v_old.version then
      v_conflicts := v_conflicts || jsonb_build_object('staff_id', m->>'staff_id', 'current_status', v_old.status,
                                                       'current_version', v_old.version);
      continue;
    end if;
    update app.staff_attendance set status = m->>'status', submission_id = v_sub, version = version + 1
     where staff_id = (m->>'staff_id')::uuid and attendance_date = p_date;
    insert into app.attendance_changes (school_id, kind, person_id, attendance_date, old_status, new_status, submission_id)
    values (c.school_id, 'staff', (m->>'staff_id')::uuid, p_date, v_old.status, m->>'status', v_sub);
    v_changed := v_changed + 1;
  end loop;
  update app.attendance_submissions set marked_count = v_marked, changed_count = v_changed where id = v_sub;
  v_prev := jsonb_build_object('submission_id', v_sub, 'marked', v_marked, 'changed', v_changed, 'conflicts', v_conflicts);
  perform private.idem_store(c.school_id, 'staff_attendance.mark', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

-- =============================================================================
-- Diary & homework
-- =============================================================================
create or replace function private.can_teach_lesson(c_role text, c_staff uuid, p_ls app.lesson_sessions)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_cap('academic.correct') or (c_role = 'teacher' and c_staff = p_ls.actual_staff_id)
$$;

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

create or replace function private.save_homework(p_rev integer, p_assignment_id uuid, p_lesson_session_id bigint,
                                                 p_due_on date, p_description text, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_hw app.homework_assignments;
begin
  select * into c from private.require_ctx(p_rev);
  if p_assignment_id is null then
    select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id;
    if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
    if not private.can_teach_lesson(c.role, c.staff_id, v_ls) then
      perform private.fail('FORBIDDEN', 'Only the teacher who took this lesson (or Admin) can set its homework');
    end if;
    insert into app.homework_assignments (school_id, academic_year_id, section_id, subject_id, lesson_session_id,
                                          assigned_by_staff, assigned_on, due_on, description, created_by)
    values (c.school_id, v_ls.academic_year_id, v_ls.section_id, v_ls.subject_id, v_ls.id,
            coalesce(c.staff_id, v_ls.actual_staff_id), v_ls.session_date, p_due_on, p_description, c.account_id)
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
    update app.homework_assignments
       set due_on = coalesce(p_due_on, due_on), description = coalesce(p_description, description),
           status = coalesce(p_status, status)
     where id = v_hw.id returning * into v_hw;
  end if;
  return jsonb_build_object('assignment_id', v_hw.id, 'version', v_hw.version);
end $$;

-- Who may check homework: Admin; subject teacher of that section+subject; class teacher;
-- or the teacher who actually took the linked lesson (substitute).
create or replace function private.can_check_homework(c_role text, c_staff uuid, p_hw app.homework_assignments, p_on date)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_cap('academic.correct')
      or (c_role = 'teacher' and (
            private.is_subject_teacher(c_staff, p_hw.section_id, p_hw.subject_id, p_on)
         or private.is_class_teacher(c_staff, p_hw.section_id, p_on)
         or exists (select 1 from app.lesson_sessions ls where ls.id = p_hw.lesson_session_id and ls.actual_staff_id = c_staff)))
$$;

-- Classroom checking roster: one row per eligible student; no row = Unchecked
create or replace function private.get_homework_roster(p_rev integer, p_assignment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_hw app.homework_assignments;
begin
  select * into c from private.require_ctx(p_rev);
  select * into v_hw from app.homework_assignments where id = p_assignment_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Homework not found'); end if;
  if not (private.has_cap('academic.read_all')
          or private.can_check_homework(c.role, c.staff_id, v_hw, private.school_today(c.school_id))) then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  return jsonb_build_object(
    'assignment', to_jsonb(v_hw) - 'school_id',
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
        'student_id', e.student_id, 'roll_no', e.roll_no, 'name', e.full_name,
        'state', case when hc.id is null then 'unchecked' else hc.completion end,
        'correction', hc.correction, 'observed_on', hc.observed_on, 'completed_on', hc.completed_on,
        'comment', hc.comment, 'version', hc.version) order by e.roll_no nulls last, e.full_name)
      from private.eligible_students(v_hw.section_id, v_hw.assigned_on) e
      left join app.homework_checks hc on hc.assignment_id = v_hw.id and hc.student_id = e.student_id), '[]'::jsonb));
end $$;

-- p_checks: [{student_id, completion, correction, completed_on, comment, expected_version}]
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

-- Parent / student / staff view of a child's homework over a range
create or replace function private.get_student_homework(p_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  if not private.can_view_student(p_student_id, 'academic.read_all') then
    perform private.fail('FORBIDDEN', 'Not permitted');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', ha.id, 'subject', sub.name, 'assigned_on', ha.assigned_on, 'due_on', ha.due_on,
      'description', ha.description,
      'state', case when hc.id is null then 'unchecked' else hc.completion end,
      'correction', hc.correction, 'observed_on', hc.observed_on, 'completed_on', hc.completed_on,
      'completed_after_due', case when hc.completed_on is not null then hc.completed_on > ha.due_on end,
      'observed_after_due', case when hc.completion = 'completed' and hc.completed_on is null then hc.observed_on > ha.due_on end,
      'comment', hc.comment) order by ha.assigned_on desc)
    from app.placements p
    join app.enrollments e on e.id = p.enrollment_id
    join app.homework_assignments ha
      on ha.section_id = p.section_id and ha.status = 'active'
     and ha.assigned_on >= greatest(p.effective_from, e.joined_on)
     and (p.effective_to is null or ha.assigned_on < p.effective_to)
    join app.subjects sub on sub.id = ha.subject_id
    left join app.homework_checks hc on hc.assignment_id = ha.id and hc.student_id = p_student_id
   where p.student_id = p_student_id and ha.assigned_on between p_from and p_to), '[]'::jsonb);
end $$;

-- =============================================================================
-- Placement moves (individual or batch) with preview (PRD SIS-02, AC-11)
-- p_moves: [{student_id, section_id, roll_no}]
-- =============================================================================
create or replace function private.move_placements(p_rev integer, p_operation_id uuid, p_effective_from date,
                                                   p_reason text, p_moves jsonb, p_preview boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c record; m jsonb; v_cur app.placements; v_sec record; v_enr uuid; v_errors jsonb; v_rows jsonb := '[]';
  v_has_errors boolean := false; v_batch uuid; v_fp text; v_prev jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('students.manage');
  if coalesce(btrim(p_reason), '') = '' then perform private.fail('VALIDATION_ERROR', 'A reason is required'); end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) not between 1 and 200 then
    perform private.fail('VALIDATION_ERROR', 'Supply 1–200 students');
  end if;
  if not p_preview then
    v_fp := private.fingerprint(jsonb_build_object('e', p_effective_from, 'r', p_reason, 'm', p_moves));
    v_prev := private.idem_lookup(c.school_id, 'placement.move', p_operation_id, v_fp);
    if v_prev is not null then return v_prev; end if;
  end if;

  for m in select * from jsonb_array_elements(p_moves) loop
    v_errors := '[]';
    select s.id, s.academic_year_id, s.class_id, ay.start_date, ay.end_date into v_sec
      from app.sections s join app.academic_years ay on ay.id = s.academic_year_id
     where s.id = (m->>'section_id')::uuid and s.school_id = c.school_id and s.status = 'active';
    if v_sec.id is null then
      v_errors := v_errors || '"Destination section not found"'::jsonb;
    elsif p_effective_from not between v_sec.start_date and v_sec.end_date then
      v_errors := v_errors || '"Effective date is outside the destination academic year"'::jsonb;
    end if;

    select * into v_cur from app.placements
     where student_id = (m->>'student_id')::uuid and school_id = c.school_id
       and effective_from <= p_effective_from and (effective_to is null or effective_to > p_effective_from);
    select id into v_enr from app.enrollments
     where student_id = (m->>'student_id')::uuid and academic_year_id = v_sec.academic_year_id and status = 'active';

    if v_enr is null then
      v_errors := v_errors || '"Student is not enrolled in that academic year"'::jsonb;
    end if;
    if v_cur.id is not null and v_cur.section_id = (m->>'section_id')::uuid then
      v_errors := v_errors || '"Student is already in that section"'::jsonb;
    end if;
    if v_cur.id is not null and v_cur.effective_from = p_effective_from then
      v_errors := v_errors || '"Current placement starts on the same date; correct it instead of moving"'::jsonb;
    end if;
    if exists (select 1 from app.placements p where p.student_id = (m->>'student_id')::uuid
                 and p.effective_from > p_effective_from) then
      v_errors := v_errors || '"A later placement already exists"'::jsonb;
    end if;
    if (m->>'roll_no') is not null and (
         exists (select 1 from app.placements p
                  where p.section_id = (m->>'section_id')::uuid and p.roll_no = m->>'roll_no'
                    and p.student_id <> (m->>'student_id')::uuid
                    and (p.effective_to is null or p.effective_to > p_effective_from)
                    -- the occupant is not leaving the section as part of this same batch
                    and not exists (select 1 from jsonb_array_elements(p_moves) o
                                     where (o->>'student_id')::uuid = p.student_id
                                       and (o->>'section_id')::uuid <> p.section_id))
         or (select count(*) from jsonb_array_elements(p_moves) o
              where o->>'section_id' = m->>'section_id' and o->>'roll_no' = m->>'roll_no') > 1) then
      v_errors := v_errors || '"Roll number already used in the destination section"'::jsonb;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'student_id', m->>'student_id', 'from_section_id', v_cur.section_id, 'to_section_id', m->>'section_id',
      'roll_no', m->>'roll_no', 'errors', v_errors,
      'class_changes', v_cur.id is not null and v_sec.class_id is distinct from
                       (select class_id from app.sections where id = v_cur.section_id),
      'fee_note', 'Existing invoices are not recalculated; add an explicit adjustment if needed',
      'marks_after_move_in_old_section',
        (select count(*) from app.student_daily_attendance d
          where d.student_id = (m->>'student_id')::uuid and d.section_id = v_cur.section_id and d.attendance_date >= p_effective_from)
        + (select count(*) from app.student_period_attendance pa join app.lesson_sessions ls on ls.id = pa.lesson_session_id
            where pa.student_id = (m->>'student_id')::uuid and ls.section_id = v_cur.section_id and pa.attendance_date >= p_effective_from));
    if jsonb_array_length(v_errors) > 0 then v_has_errors := true; end if;
  end loop;

  if p_preview or v_has_errors then
    return jsonb_build_object('preview', true, 'can_apply', not v_has_errors, 'rows', v_rows);
  end if;

  insert into app.placement_batches (school_id, operation_id, effective_from, reason, student_count, created_by)
  values (c.school_id, p_operation_id, p_effective_from, p_reason, jsonb_array_length(p_moves), c.account_id)
  returning id into v_batch;

  -- close all current placements first (frees roll numbers inside the batch), then open new ones
  update app.placements p set effective_to = p_effective_from
   where p.school_id = c.school_id and p.effective_from < p_effective_from
     and (p.effective_to is null or p.effective_to > p_effective_from)
     and p.student_id in (select (x->>'student_id')::uuid from jsonb_array_elements(p_moves) x);

  insert into app.placements (school_id, academic_year_id, enrollment_id, student_id, section_id, roll_no,
                              effective_from, reason, batch_id, created_by)
  select c.school_id, s.academic_year_id, e.id, e.student_id, s.id, x->>'roll_no', p_effective_from, p_reason, v_batch, c.account_id
    from jsonb_array_elements(p_moves) x
    join app.sections s on s.id = (x->>'section_id')::uuid
    join app.enrollments e on e.student_id = (x->>'student_id')::uuid and e.academic_year_id = s.academic_year_id;

  v_prev := jsonb_build_object('preview', false, 'batch_id', v_batch, 'moved', jsonb_array_length(p_moves), 'rows', v_rows);
  perform private.idem_store(c.school_id, 'placement.move', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

-- ---------------------------------------------------------------- public wrappers
create or replace function public.generate_lesson_sessions(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.generate_lesson_sessions(p_ctx_rev, p_from, p_to, p_section_id) $$;
create or replace function public.get_date_schedule(p_ctx_rev integer, p_date date, p_section_id uuid default null, p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_date_schedule(p_ctx_rev, p_date, p_section_id, p_staff_id) $$;
create or replace function public.update_lesson_session(p_ctx_rev integer, p_lesson_session_id bigint, p_action text, p_subject_id uuid default null, p_reason text default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.update_lesson_session(p_ctx_rev, p_lesson_session_id, p_action, p_subject_id, p_reason, p_expected_version) $$;
create or replace function public.suggest_substitutes(p_ctx_rev integer, p_lesson_session_id bigint)
returns jsonb language sql security invoker set search_path = '' as $$ select private.suggest_substitutes(p_ctx_rev, p_lesson_session_id) $$;
create or replace function public.assign_substitute(p_ctx_rev integer, p_lesson_session_id bigint, p_staff_id uuid, p_reason text default null, p_conflict_reason text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.assign_substitute(p_ctx_rev, p_lesson_session_id, p_staff_id, p_reason, p_conflict_reason) $$;
create or replace function public.remove_substitute(p_ctx_rev integer, p_lesson_session_id bigint)
returns jsonb language sql security invoker set search_path = '' as $$ select private.remove_substitute(p_ctx_rev, p_lesson_session_id) $$;
create or replace function public.get_marking_roster(p_ctx_rev integer, p_kind text, p_section_id uuid default null, p_date date default null, p_lesson_session_id bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_marking_roster(p_ctx_rev, p_kind, p_section_id, p_date, p_lesson_session_id) $$;
create or replace function public.mark_student_attendance(p_ctx_rev integer, p_operation_id uuid, p_kind text, p_marks jsonb, p_section_id uuid default null, p_date date default null, p_lesson_session_id bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.mark_student_attendance(p_ctx_rev, p_operation_id, p_kind, p_section_id, p_date, p_lesson_session_id, p_marks) $$;
create or replace function public.get_student_attendance_summary(p_ctx_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_student_attendance_summary(p_ctx_rev, p_student_id, p_from, p_to) $$;
create or replace function public.get_attendance_overview(p_ctx_rev integer, p_date date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_attendance_overview(p_ctx_rev, p_date) $$;
create or replace function public.mark_staff_attendance(p_ctx_rev integer, p_operation_id uuid, p_date date, p_marks jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.mark_staff_attendance(p_ctx_rev, p_operation_id, p_date, p_marks) $$;
create or replace function public.save_diary_entry(p_ctx_rev integer, p_lesson_session_id bigint, p_body text, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_diary_entry(p_ctx_rev, p_lesson_session_id, p_body, p_expected_version) $$;
create or replace function public.save_homework(p_ctx_rev integer, p_assignment_id uuid default null, p_lesson_session_id bigint default null, p_due_on date default null, p_description text default null, p_status text default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_homework(p_ctx_rev, p_assignment_id, p_lesson_session_id, p_due_on, p_description, p_status, p_expected_version) $$;
create or replace function public.get_homework_roster(p_ctx_rev integer, p_assignment_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_homework_roster(p_ctx_rev, p_assignment_id) $$;
create or replace function public.mark_homework_checks(p_ctx_rev integer, p_operation_id uuid, p_assignment_id uuid, p_observed_on date, p_checks jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.mark_homework_checks(p_ctx_rev, p_operation_id, p_assignment_id, p_observed_on, p_checks) $$;
create or replace function public.get_student_homework(p_ctx_rev integer, p_student_id uuid, p_from date, p_to date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_student_homework(p_ctx_rev, p_student_id, p_from, p_to) $$;
create or replace function public.move_placements(p_ctx_rev integer, p_operation_id uuid, p_effective_from date, p_reason text, p_moves jsonb, p_preview boolean default true)
returns jsonb language sql security invoker set search_path = '' as $$ select private.move_placements(p_ctx_rev, p_operation_id, p_effective_from, p_reason, p_moves, p_preview) $$;

grant execute on function
  private.generate_lesson_sessions(integer, date, date, uuid), private.get_date_schedule(integer, date, uuid, uuid),
  private.update_lesson_session(integer, bigint, text, uuid, text, integer), private.suggest_substitutes(integer, bigint),
  private.assign_substitute(integer, bigint, uuid, text, text), private.remove_substitute(integer, bigint),
  private.get_marking_roster(integer, text, uuid, date, bigint),
  private.mark_student_attendance(integer, uuid, text, uuid, date, bigint, jsonb),
  private.get_student_attendance_summary(integer, uuid, date, date), private.get_attendance_overview(integer, date),
  private.mark_staff_attendance(integer, uuid, date, jsonb), private.save_diary_entry(integer, bigint, text, integer),
  private.save_homework(integer, uuid, bigint, date, text, text, integer), private.get_homework_roster(integer, uuid),
  private.mark_homework_checks(integer, uuid, uuid, date, jsonb), private.get_student_homework(integer, uuid, date, date),
  private.move_placements(integer, uuid, date, text, jsonb, boolean)
to authenticated;
grant execute on function
  public.generate_lesson_sessions(integer, date, date, uuid), public.get_date_schedule(integer, date, uuid, uuid),
  public.update_lesson_session(integer, bigint, text, uuid, text, integer), public.suggest_substitutes(integer, bigint),
  public.assign_substitute(integer, bigint, uuid, text, text), public.remove_substitute(integer, bigint),
  public.get_marking_roster(integer, text, uuid, date, bigint),
  public.mark_student_attendance(integer, uuid, text, jsonb, uuid, date, bigint),
  public.get_student_attendance_summary(integer, uuid, date, date), public.get_attendance_overview(integer, date),
  public.mark_staff_attendance(integer, uuid, date, jsonb), public.save_diary_entry(integer, bigint, text, integer),
  public.save_homework(integer, uuid, bigint, date, text, text, integer), public.get_homework_roster(integer, uuid),
  public.mark_homework_checks(integer, uuid, uuid, date, jsonb), public.get_student_homework(integer, uuid, date, date),
  public.move_placements(integer, uuid, date, text, jsonb, boolean)
to authenticated;
