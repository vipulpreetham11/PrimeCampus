-- =============================================================================
-- PrimeCampus V1 — 2410 M4 plan additions (from the M4 plan review)
--  * get_date_schedule: `source` (timetable / override / extra), actual_teacher_absent; ordered by start time.
--    get_teacher_today lessons: `source`
--  * get_salary_calculations: calculated_by name for every version
--  * op_get_audit_events: actor_username, actor_name, school_name; action prefix uses starts_with;
--    next_before_id only on a full page (also op_get_auth_events)
--  * list_homework: p_due_unchecked (due date in range and no checks yet) — the dashboard's homework number
--  * get_dashboard fees: dues/overdue for the CURRENT year (as the Dues page) + older_years_due_paise
--  * compute_salary: marked_days {present, late, half_day, absent}
--  * get_salary_month: status for every reader (not only managers); 'changed' also when days/salary differ
--    (not only payable) or new unmarked days appear; live numbers still only for managers
--  * note: 2400's header mentions 'change_teacher' — not implemented; substitutions cover it (M2)
-- =============================================================================
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
      'status', ls.status, 'cancel_reason', ls.cancel_reason, 'version', ls.version, 'source', ls.source,
      'actual_teacher_absent', (select sa.status = 'A' from app.staff_attendance sa
                                  where sa.staff_id = ls.actual_staff_id and sa.attendance_date = ls.session_date),
      'planned_teacher_absent', (select sa.status = 'A' from app.staff_attendance sa
                                  where sa.staff_id = ls.planned_staff_id and sa.attendance_date = ls.session_date),
      'planned_teacher_half_day', (select sa.status = 'H' from app.staff_attendance sa
                                  where sa.staff_id = ls.planned_staff_id and sa.attendance_date = ls.session_date),
      'has_diary', exists (select 1 from app.diary_entries de where de.lesson_session_id = ls.id),
      'homework_count', (select count(*) from app.homework_assignments h where h.lesson_session_id = ls.id and h.status = 'active'),
      'is_substituted', ls.actual_staff_id is distinct from ls.planned_staff_id,
      'unassigned', ls.actual_staff_id is null
    ) order by cl.sort_order, sec.name, ls.start_time, ls.slot_ordinal)
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
        'version', ls.version, 'source', ls.source,
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
        'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = h.section_id),
        'subject_id', h.subject_id, 'subject', (select name from app.subjects where id = h.subject_id),
        'assigned_on', h.assigned_on, 'due_on', h.due_on, 'version', h.version,
        'eligible', (select count(*) from private.eligible_students(h.section_id, h.assigned_on)),
        'checked', (select count(*) from app.homework_checks hc where hc.assignment_id = h.id)) order by h.due_on, h.id)
      from app.homework_assignments h
     where h.school_id = c.school_id and h.status = 'active' and h.assigned_by_staff = c.staff_id
       and h.due_on between v_date - 14 and v_date), '[]'));
end $$;
create or replace function private.get_salary_calculations(p_rev integer, p_month date, p_staff_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.read');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', sc.id, 'staff_id', sc.staff_id, 'staff_name', s.full_name, 'employee_no', s.employee_no,
      'month', sc.month, 'version_no', sc.version_no, 'status', sc.status,
      'monthly_salary_paise', sc.monthly_salary_paise, 'working_days', sc.working_days,
      'attended_days', sc.attended_days, 'paid_leave_days', sc.paid_leave_days, 'unpaid_days', sc.unpaid_days,
      'payable_paise', sc.payable_paise, 'discrepancies', sc.discrepancies, 'overrides', sc.overrides,
      'override_reason', sc.override_reason, 'created_at', sc.created_at,
      'calculated_by', (select display_name from app.accounts where id = sc.calculated_by)) order by s.full_name, sc.version_no desc)
    from app.salary_calculations sc join app.staff s on s.id = sc.staff_id
   where sc.school_id = c.school_id
     and (p_month is null or sc.month = date_trunc('month', p_month)::date)
     and (p_staff_id is null or sc.staff_id = p_staff_id)), '[]'::jsonb);
end $$;


create or replace function private.op_get_audit_events(p_school_id uuid, p_actor_id uuid, p_action_prefix text,
                                                       p_entity_id text, p_from timestamptz, p_to timestamptz,
                                                       p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform private.require_operator();
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') into v_items from (
    select ev.*, (select username from app.accounts where id = ev.actor_id) as actor_username,
           (select display_name from app.accounts where id = ev.actor_id) as actor_name,
           (select name from app.schools where id = ev.school_id) as school_name
      from private.audit_events ev
     where (p_school_id is null or ev.school_id = p_school_id)
       and (p_actor_id is null or ev.actor_id = p_actor_id)
       and (p_action_prefix is null or starts_with(ev.action, p_action_prefix))
       and (p_entity_id is null or ev.entity_id = p_entity_id)
       and (p_from is null or ev.occurred_at >= p_from) and (p_to is null or ev.occurred_at < p_to)
       and (p_before_id is null or ev.id < p_before_id)
     order by ev.id desc limit least(coalesce(p_limit, 50), 100)) e;
  return jsonb_build_object('items', v_items,
                            'next_before_id', case when jsonb_array_length(v_items) = least(coalesce(p_limit, 50), 100)
                                                   then (select min((x->>'id')::bigint) from jsonb_array_elements(v_items) x) end);
end $$;


create or replace function private.op_get_auth_events(p_account_id uuid, p_school_id uuid, p_from timestamptz,
                                                      p_to timestamptz, p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform private.require_operator();
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') into v_items from (
    select ae.*, a.username from private.auth_events ae left join app.accounts a on a.id = ae.account_id
     where (p_account_id is null or ae.account_id = p_account_id)
       and (p_school_id is null or ae.school_id = p_school_id)
       and (p_from is null or ae.occurred_at >= p_from) and (p_to is null or ae.occurred_at < p_to)
       and (p_before_id is null or ae.id < p_before_id)
     order by ae.id desc limit least(coalesce(p_limit, 50), 100)) e;
  return jsonb_build_object('items', v_items,
                            'next_before_id', case when jsonb_array_length(v_items) = least(coalesce(p_limit, 50), 100)
                                                   then (select min((x->>'id')::bigint) from jsonb_array_elements(v_items) x) end);
end $$;


drop function if exists public.list_homework(integer, date, date, uuid, uuid, uuid, text, date, uuid, integer);
drop function if exists private.list_homework(integer, uuid, uuid, uuid, date, date, text, date, uuid, integer);
create or replace function private.list_homework(p_rev integer, p_section_id uuid, p_subject_id uuid, p_staff_id uuid,
                                                 p_from date, p_to date, p_status text, p_before_date date, p_before_id uuid,
                                                 p_limit integer, p_due_unchecked boolean)
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
     where ha.school_id = c.school_id
       and (case when coalesce(p_due_unchecked, false)
                 then ha.due_on between p_from and p_to
                      and not exists (select 1 from app.homework_checks hc0 where hc0.assignment_id = ha.id)
                 else ha.assigned_on between p_from and p_to end)
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


create or replace function private.get_dashboard(p_rev integer, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_today date; v_date date; v_out jsonb; v_ov jsonb; v_year uuid; v_prev_month date; v_issues jsonb := '[]';
begin
  select * into c from private.require_ctx(p_rev);
  v_today := private.school_today(c.school_id);
  v_date := coalesce(p_date, v_today);
  if v_date > v_today then perform private.fail('VALIDATION_ERROR', 'Choose today or an earlier date'); end if;
  v_year := (select id from app.academic_years where school_id = c.school_id and is_current);
  v_out := jsonb_build_object('date', v_date, 'today', v_today, 'role', c.role,
    'day', (select to_jsonb(r) from private.resolve_day(c.school_id, 'student', null, v_date) r));

  if private.has_cap('attendance.summary') then
    v_ov := private.get_attendance_overview(p_rev, v_date);
    v_out := v_out || jsonb_build_object('attendance', jsonb_build_object(
      'mode', v_ov->'mode',
      'sections_expected', (select count(*) from jsonb_array_elements(v_ov->'sections') x where (x->>'expected')::int > 0),
      'sections_complete', (select count(*) from jsonb_array_elements(v_ov->'sections') x
                             where (x->>'expected')::int > 0 and (x->>'marked')::int >= (x->>'expected')::int),
      'sections_not_started', (select count(*) from jsonb_array_elements(v_ov->'sections') x
                             where (x->>'expected')::int > 0 and (x->>'marked')::int = 0),
      'expected', (select coalesce(sum((x->>'expected')::int), 0) from jsonb_array_elements(v_ov->'sections') x),
      'marked', (select coalesce(sum((x->>'marked')::int), 0) from jsonb_array_elements(v_ov->'sections') x),
      'present', (select coalesce(sum((x->>'present')::numeric), 0) from jsonb_array_elements(v_ov->'sections') x)));
  end if;

  if private.has_cap('staff_attendance.read') then
    v_out := v_out || jsonb_build_object('staff', jsonb_build_object(
      'active_staff', (select count(*) from app.staff where school_id = c.school_id and status = 'active'
                         and joined_on <= v_date and (left_on is null or left_on >= v_date)),
      'marked', (select count(*) from app.staff_attendance where school_id = c.school_id and attendance_date = v_date),
      'absent', (select count(*) from app.staff_attendance where school_id = c.school_id and attendance_date = v_date and status = 'A'),
      'half_day', (select count(*) from app.staff_attendance where school_id = c.school_id and attendance_date = v_date and status = 'H'),
      'lessons_with_absent_teacher', (select count(*) from app.lesson_sessions ls
          join app.staff_attendance sa on sa.staff_id = ls.actual_staff_id and sa.attendance_date = ls.session_date and sa.status = 'A'
         where ls.school_id = c.school_id and ls.session_date = v_date and ls.status = 'scheduled')));
  end if;

  if private.has_cap('academic.read_all') then
    v_out := v_out || jsonb_build_object('academic', jsonb_build_object(
      'lessons_today', (select count(*) from app.lesson_sessions where school_id = c.school_id and session_date = v_date and status = 'scheduled'),
      'diary_missing_last_7_days', (select count(*) from app.lesson_sessions ls
          where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.session_date between v_date - 7 and v_date - 1
            and not exists (select 1 from app.diary_entries de where de.lesson_session_id = ls.id)),
      'homework_due_unchecked_from', v_date - 14,
      'homework_due_unchecked', (select count(*) from app.homework_assignments h
          where h.school_id = c.school_id and h.status = 'active' and h.due_on between v_date - 14 and v_date
            and not exists (select 1 from app.homework_checks hc where hc.assignment_id = h.id))));
  end if;

  if private.has_cap('admissions.manage') or (c.admissions_duty is true) then
    v_out := v_out || jsonb_build_object('admissions', jsonb_build_object(
      'followups_overdue', (select count(*) from app.leads where school_id = c.school_id and stage not in ('converted','lost')
                              and next_follow_up_on < v_today),
      'followups_today', (select count(*) from app.leads where school_id = c.school_id and stage not in ('converted','lost')
                              and next_follow_up_on = v_today),
      'open_leads', (select count(*) from app.leads where school_id = c.school_id and stage not in ('converted','lost'))));
  end if;

  if private.has_cap('fees.read') then
    v_out := v_out || jsonb_build_object('fees', jsonb_build_object(
      'collected_on_date', (select jsonb_build_object('count', count(*), 'amount_paise', coalesce(sum(amount_paise), 0))
                              from app.collections where school_id = c.school_id and received_on = v_date),
      'academic_year_id', v_year,
      'due_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, null, v_year)),
      'overdue_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, null, v_year) b
                          where b.due_date < v_today),
      'older_years_due_paise', (select coalesce(sum(b.balance_paise), 0) from private.invoice_balances(c.school_id, null, null) b
                                 where b.academic_year_id is distinct from v_year),
      'pending_cheques', (select jsonb_build_object('count', count(*), 'amount_paise', coalesce(sum(amount_paise), 0))
                            from app.cheques where school_id = c.school_id and status = 'pending'),
      'open_exceptions', (select count(*) from app.payment_exceptions where school_id = c.school_id and status = 'open')));
  end if;

  if private.has_cap('staff_finance.read') then
    v_prev_month := (date_trunc('month', v_today) - interval '1 month')::date;
    v_out := v_out || jsonb_build_object('salary', jsonb_build_object(
      'month', v_prev_month,
      'staff', (select count(*) from app.staff where school_id = c.school_id and joined_on < date_trunc('month', v_today)::date
                  and (left_on is null or left_on >= v_prev_month)),
      'saved', (select count(*) from app.salary_calculations where school_id = c.school_id and month = v_prev_month and status = 'final'),
      'saved_payable_paise', (select coalesce(sum(payable_paise), 0) from app.salary_calculations
                                where school_id = c.school_id and month = v_prev_month and status = 'final')));
  end if;

  if private.has_cap('setup.manage') then
    if v_year is null then v_issues := v_issues || jsonb_build_object('code', 'no_current_year', 'message', 'No current academic year is set'); end if;
    if v_year is not null and not exists (select 1 from app.sections where academic_year_id = v_year and status = 'active') then
      v_issues := v_issues || jsonb_build_object('code', 'no_sections', 'message', 'The current year has no sections');
    end if;
    if v_year is not null then
      v_issues := v_issues || coalesce((select jsonb_agg(jsonb_build_object('code', 'no_timetable', 'section_id', s.id,
                    'message', cl.name || ' ' || s.name || ' has no active timetable'))
                  from app.sections s join app.classes cl on cl.id = s.class_id
                 where s.academic_year_id = v_year and s.status = 'active'
                   and not exists (select 1 from app.timetable_versions tv where tv.section_id = s.id and tv.status = 'active')), '[]'::jsonb);
      v_issues := v_issues || coalesce((select jsonb_agg(jsonb_build_object('code', 'no_class_teacher', 'section_id', s.id,
                    'message', cl.name || ' ' || s.name || ' has no class teacher today'))
                  from app.sections s join app.classes cl on cl.id = s.class_id
                 where s.academic_year_id = v_year and s.status = 'active'
                   and not exists (select 1 from app.teaching_assignments ta where ta.section_id = s.id and ta.kind = 'class_teacher'
                                     and ta.effective_from <= v_today and (ta.effective_to is null or ta.effective_to > v_today))), '[]'::jsonb);
    end if;
    if not exists (select 1 from app.attendance_modes where school_id = c.school_id) then
      v_issues := v_issues || jsonb_build_object('code', 'no_attendance_mode', 'message', 'Attendance mode is not chosen (day-wise is used)');
    end if;
    v_out := v_out || jsonb_build_object('setup_issues', v_issues);
  end if;
  return v_out;
end $$;


create or replace function private.compute_salary(p_school uuid, p_staff uuid, p_month date, p_overrides jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_st app.staff; d date; r record; v_att text; v_leave numeric; v_w numeric := 0; v_a numeric := 0; v_p numeric := 0;
  v_credit numeric; v_salary bigint; v_np integer := 0; v_nl integer := 0; v_nh integer := 0; v_nab integer := 0; v_disc jsonb := '[]'; v_unmarked jsonb := '[]'; v_end date;
  v_ov jsonb := coalesce(p_overrides, '{}');
begin
  select * into v_st from app.staff where id = p_staff and school_id = p_school;
  if not found then perform private.fail('NOT_FOUND', 'Staff not found'); end if;
  p_month := date_trunc('month', p_month)::date;
  v_end := (p_month + interval '1 month - 1 day')::date;

  select monthly_salary_paise into v_salary from app.staff_salary_rates
   where staff_id = p_staff and effective_from <= v_end order by effective_from desc limit 1;
  if v_salary is null then
    select monthly_salary_paise into v_salary from app.staff_group_salary_defaults where staff_group_id = v_st.staff_group_id;
  end if;

  for d in select g::date from generate_series(p_month, v_end, interval '1 day') g loop
    select * into r from private.resolve_day(p_school, 'staff', v_st.staff_group_id, d);
    select status into v_att from app.staff_attendance where staff_id = p_staff and attendance_date = d;
    select day_fraction into v_leave from app.staff_paid_leave where staff_id = p_staff and leave_date = d and status = 'active';
    if r.weight = 0 then
      if v_att in ('P','L','H') then v_disc := v_disc || jsonb_build_object('date', d, 'issue', 'attendance_on_non_working_day'); end if;
      if v_leave is not null then v_disc := v_disc || jsonb_build_object('date', d, 'issue', 'paid_leave_on_non_working_day_ignored'); end if;
      continue;
    end if;
    v_w := v_w + r.weight;
    if d < v_st.joined_on or (v_st.left_on is not null and d > v_st.left_on) then
      v_disc := v_disc || jsonb_build_object('date', d, 'issue', 'not_employed_on_working_day');
      continue;
    end if;
    v_credit := case v_att when 'P' then r.weight when 'L' then r.weight when 'H' then r.weight * 0.5 else 0 end;
    if v_att = 'P' then v_np := v_np + 1; elsif v_att = 'L' then v_nl := v_nl + 1;
    elsif v_att = 'H' then v_nh := v_nh + 1; elsif v_att = 'A' then v_nab := v_nab + 1; end if;
    v_a := v_a + v_credit;
    if v_leave is not null then
      if v_leave > r.weight - v_credit then
        v_disc := v_disc || jsonb_build_object('date', d, 'issue', 'paid_leave_overlaps_attendance_capped');
      end if;
      v_p := v_p + greatest(least(v_leave, r.weight - v_credit), 0);
    elsif v_att is null then
      v_unmarked := v_unmarked || to_jsonb(d);
    end if;
  end loop;

  if v_ov ? 'working_days' then v_w := (v_ov->>'working_days')::numeric; end if;
  if v_ov ? 'attended_days' then v_a := (v_ov->>'attended_days')::numeric; end if;
  if v_ov ? 'paid_leave_days' then v_p := (v_ov->>'paid_leave_days')::numeric; end if;
  if v_ov ? 'monthly_salary_paise' then v_salary := (v_ov->>'monthly_salary_paise')::bigint; end if;
  if exists (select 1 from jsonb_object_keys(v_ov) k
              where k not in ('working_days','attended_days','paid_leave_days','monthly_salary_paise')) then
    perform private.fail('VALIDATION_ERROR', 'Unknown override field');
  end if;

  v_w := round(v_w, 2); v_a := round(v_a, 2); v_p := round(v_p, 2);
  return jsonb_build_object(
    'staff_id', p_staff, 'month', p_month, 'monthly_salary_paise', v_salary,
    'working_days', v_w, 'attended_days', v_a, 'paid_leave_days', v_p,
    'unpaid_days', v_w - v_a - v_p,
    'marked_days', jsonb_build_object('present', v_np, 'late', v_nl, 'half_day', v_nh, 'absent', v_nab),
    'payable_paise', case when v_w > 0 and v_salary is not null and v_a + v_p <= v_w and v_a >= 0 and v_p >= 0
                          then round(v_salary * (v_a + v_p) / v_w) end,
    'needs_manual_resolution', v_w <= 0 or v_salary is null,
    'resolution_reason', case when v_salary is null then 'No salary rate recorded'
                              when v_w <= 0 then 'No working days in this month for this staff calendar' end,
    'unmarked_working_dates', v_unmarked, 'discrepancies', v_disc, 'overrides', v_ov);
end $$;


create or replace function private.get_salary_month(p_rev integer, p_month date, p_staff_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_month date := date_trunc('month', p_month)::date; v_end date; v_manage boolean; s record;
        v_rows jsonb := '[]'; v_saved app.salary_calculations; v_live jsonb; v_status text; v_cmp jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.read');
  if p_month is null then perform private.fail('VALIDATION_ERROR', 'Choose a month'); end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  v_manage := private.has_cap('staff_finance.manage');
  for s in select st.id, st.full_name, st.employee_no, st.staff_group_id, g.name as group_name, st.joined_on, st.left_on
             from app.staff st left join app.staff_groups g on g.id = st.staff_group_id
            where st.school_id = c.school_id and st.joined_on <= v_end and (st.left_on is null or st.left_on >= v_month)
              and (p_staff_group_id is null or st.staff_group_id = p_staff_group_id)
            order by st.full_name loop
    select * into v_saved from app.salary_calculations where staff_id = s.id and month = v_month and status = 'final';
    v_live := null; v_cmp := null;
    -- status for every reader; live numbers only for managers
    v_live := private.compute_salary(c.school_id, s.id, v_month, null);
    if v_saved.id is not null then
      v_cmp := private.compute_salary(c.school_id, s.id, v_month, v_saved.overrides);
    end if;
    v_status := case
      when v_saved.id is not null and (
             (v_cmp->>'payable_paise')::bigint is distinct from v_saved.payable_paise
          or (v_live->>'working_days')::numeric is distinct from v_saved.working_days and not (v_saved.overrides ? 'working_days')
          or (v_live->>'attended_days')::numeric is distinct from v_saved.attended_days and not (v_saved.overrides ? 'attended_days')
          or (v_live->>'paid_leave_days')::numeric is distinct from v_saved.paid_leave_days and not (v_saved.overrides ? 'paid_leave_days')
          or (v_live->>'monthly_salary_paise')::bigint is distinct from v_saved.monthly_salary_paise and not (v_saved.overrides ? 'monthly_salary_paise')
          or jsonb_array_length(v_live->'unmarked_working_dates') > 0 and v_saved.discrepancies->'unmarked_working_dates' is distinct from v_live->'unmarked_working_dates'
        ) then 'changed'
      when v_saved.id is not null then 'saved'
      when v_live is not null and (v_live->>'needs_manual_resolution')::boolean then 'needs_resolution'
      else 'not_saved' end;
    v_rows := v_rows || jsonb_build_object(
      'staff_id', s.id, 'name', s.full_name, 'employee_no', s.employee_no, 'staff_group_id', s.staff_group_id,
      'group', s.group_name, 'joined_on', s.joined_on, 'left_on', s.left_on,
      'partial_month', s.joined_on > v_month or (s.left_on is not null and s.left_on < v_end),
      'status', v_status,
      'saved', case when v_saved.id is not null then jsonb_build_object('id', v_saved.id, 'version_no', v_saved.version_no,
                 'monthly_salary_paise', v_saved.monthly_salary_paise, 'working_days', v_saved.working_days,
                 'attended_days', v_saved.attended_days, 'paid_leave_days', v_saved.paid_leave_days,
                 'unpaid_days', v_saved.unpaid_days, 'payable_paise', v_saved.payable_paise,
                 'overrides', v_saved.overrides, 'override_reason', v_saved.override_reason, 'created_at', v_saved.created_at,
                 'calculated_by', (select display_name from app.accounts where id = v_saved.calculated_by)) end,
      'live', case when v_manage then jsonb_build_object(
                 'monthly_salary_paise', v_live->'monthly_salary_paise', 'working_days', v_live->'working_days',
                 'attended_days', v_live->'attended_days', 'paid_leave_days', v_live->'paid_leave_days',
                 'unpaid_days', v_live->'unpaid_days', 'payable_paise', v_live->'payable_paise', 'marked_days', v_live->'marked_days',
                 'needs_manual_resolution', v_live->'needs_manual_resolution', 'resolution_reason', v_live->'resolution_reason',
                 'unmarked_count', jsonb_array_length(v_live->'unmarked_working_dates'),
                 'discrepancy_count', jsonb_array_length(v_live->'discrepancies')) end);
  end loop;
  return jsonb_build_object('month', v_month, 'can_manage', v_manage, 'rows', v_rows,
    'totals', jsonb_build_object(
      'staff', jsonb_array_length(v_rows),
      'saved', (select count(*) from jsonb_array_elements(v_rows) x where x->>'status' in ('saved','changed')),
      'changed', (select count(*) from jsonb_array_elements(v_rows) x where x->>'status' = 'changed'),
      'needs_resolution', (select count(*) from jsonb_array_elements(v_rows) x where x->>'status' = 'needs_resolution'),
      'not_saved', (select count(*) from jsonb_array_elements(v_rows) x where x->>'status' = 'not_saved'),
      'saved_payable_paise', (select coalesce(sum((x->'saved'->>'payable_paise')::bigint), 0) from jsonb_array_elements(v_rows) x)));
end $$;


create or replace function public.list_homework(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null, p_subject_id uuid default null, p_staff_id uuid default null, p_status text default 'active', p_before_date date default null, p_before_id uuid default null, p_limit integer default 50, p_due_unchecked boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_homework(p_ctx_rev, p_section_id, p_subject_id, p_staff_id, p_from, p_to, p_status, p_before_date, p_before_id, p_limit, p_due_unchecked) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
revoke execute on function private.run_maintenance(text) from authenticated;
grant execute on function
  private.list_homework(integer, uuid, uuid, uuid, date, date, text, date, uuid, integer, boolean)
to authenticated;
grant execute on function
  public.list_homework(integer, date, date, uuid, uuid, uuid, text, date, uuid, integer, boolean)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
