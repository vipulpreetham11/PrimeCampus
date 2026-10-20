-- =============================================================================
-- PrimeCampus V1 — 2400 M4 backend (salary, reports, lesson overrides, dashboard, maintenance)
--  * salary: get_salary_month (all staff of a month: live preview for managers, saved snapshot for
--    readers, status not_saved / saved / changed / needs_resolution, totals); save_salary_calculation
--    validates overrides with readable errors and replays when nothing changed (no duplicate versions);
--    record_paid_leave / list_paid_leave with validation
--  * attendance: get_attendance_register (section × month grid, daily and period modes, totals with
--    provisional flag); list_attendance_changes (who changed which mark, old → new)
--  * academic coverage for the Principal: get_academic_coverage (lessons, diary, homework set/checked,
--    period attendance marked — per section/subject/teacher)
--  * fees: get_fee_head_report (charged / concession / adjustments per head; collected per invoice)
--  * timetable (TIME-02): update_lesson_session 'change_time' and 'change_teacher'; add_extra_lesson
--  * get_dashboard: one capability-scoped summary for the home screens
--  * maintenance: private.run_maintenance (retention cleanup + idle app-session expiry), scheduled daily
--    with pg_cron where available; op_get_maintenance for the Operator
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Salary
-- -----------------------------------------------------------------------------
create or replace function private.salary_overrides_check(p jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare k text; v text;
begin
  if p is null then return; end if;
  if jsonb_typeof(p) <> 'object' then perform private.fail('VALIDATION_ERROR', 'Overrides must be an object'); end if;
  for k, v in select key, value::text from jsonb_each(p) loop
    if k not in ('working_days','attended_days','paid_leave_days','monthly_salary_paise') then
      perform private.fail('VALIDATION_ERROR', 'Unknown override "' || k || '"', jsonb_build_object('field', k));
    end if;
    if jsonb_typeof(p->k) <> 'number' then
      perform private.fail('VALIDATION_ERROR', 'Overrides must be numbers', jsonb_build_object('field', k));
    end if;
    if k = 'monthly_salary_paise' then
      if (p->>k) !~ '^\d{1,12}$' or (p->>k)::bigint > 100000000000 then
        perform private.fail('VALIDATION_ERROR', 'Monthly salary must be whole paise, ₹0 or more', jsonb_build_object('field', k));
      end if;
    elsif (p->>k)::numeric < 0 or (p->>k)::numeric > 31 or (p->>k)::numeric * 2 <> trunc((p->>k)::numeric * 2) then
      perform private.fail('VALIDATION_ERROR', 'Days must be 0–31 in steps of 0.5', jsonb_build_object('field', k));
    end if;
  end loop;
end $$;

create or replace function private.save_salary_calculation(p_rev integer, p_staff_id uuid, p_month date,
                                                           p_overrides jsonb, p_override_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v jsonb; v_prev app.salary_calculations; v_id uuid; v_month date := date_trunc('month', p_month)::date;
        v_ov jsonb := coalesce(p_overrides, '{}'::jsonb);
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.manage');
  if p_month is null then perform private.fail('VALIDATION_ERROR', 'Choose a month'); end if;
  if v_month > date_trunc('month', private.school_today(c.school_id))::date then
    perform private.fail('VALIDATION_ERROR', 'A future month can''t be calculated yet');
  end if;
  perform private.salary_overrides_check(v_ov);
  if v_ov <> '{}'::jsonb and coalesce(btrim(p_override_reason), '') = '' then
    perform private.fail('VALIDATION_ERROR', 'Overrides need a reason', jsonb_build_object('field', 'override_reason'));
  end if;
  if length(p_override_reason) > 500 then perform private.fail('VALIDATION_ERROR', 'Reason can be at most 500 characters'); end if;
  -- one save at a time per staff member
  perform 1 from app.staff where id = p_staff_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Staff not found'); end if;
  v := private.compute_salary(c.school_id, p_staff_id, v_month, v_ov);
  if (v->>'needs_manual_resolution')::boolean then
    perform private.fail('VALIDATION_ERROR', coalesce(v->>'resolution_reason', 'Manual resolution needed') ||
                         '. Enter overrides with a reason.', v);
  end if;
  if (v->>'payable_paise') is null then
    perform private.fail('VALIDATION_ERROR', 'Paid days cannot exceed working days or be negative', v);
  end if;
  select * into v_prev from app.salary_calculations where staff_id = p_staff_id and month = v_month and status = 'final' for update;
  if found and v_prev.payable_paise = (v->>'payable_paise')::bigint
     and v_prev.monthly_salary_paise = (v->>'monthly_salary_paise')::bigint
     and v_prev.working_days = (v->>'working_days')::numeric and v_prev.attended_days = (v->>'attended_days')::numeric
     and v_prev.paid_leave_days = (v->>'paid_leave_days')::numeric and v_prev.overrides = v_ov
     and coalesce(v_prev.override_reason, '') = coalesce(btrim(p_override_reason), '') then
    return v || jsonb_build_object('salary_calculation_id', v_prev.id, 'version_no', v_prev.version_no, 'replayed', true);
  end if;
  if found then
    update app.salary_calculations set status = 'superseded' where id = v_prev.id;
  end if;
  insert into app.salary_calculations (school_id, staff_id, month, version_no, supersedes_id, monthly_salary_paise,
                                       working_days, attended_days, paid_leave_days, unpaid_days, payable_paise,
                                       discrepancies, overrides, override_reason, inputs, calculated_by)
  values (c.school_id, p_staff_id, v_month, coalesce(v_prev.version_no, 0) + 1, v_prev.id,
          (v->>'monthly_salary_paise')::bigint, (v->>'working_days')::numeric, (v->>'attended_days')::numeric,
          (v->>'paid_leave_days')::numeric, greatest((v->>'unpaid_days')::numeric, 0), (v->>'payable_paise')::bigint,
          jsonb_build_object('unmarked_working_dates', v->'unmarked_working_dates', 'items', v->'discrepancies'),
          v_ov, nullif(btrim(p_override_reason), ''),
          jsonb_build_object('computed_at', now(), 'calendar', 'staff', 'staff_group_id',
                             (select staff_group_id from app.staff where id = p_staff_id)),
          c.account_id)
  returning id into v_id;
  perform private.log_event('salary.calculation.saved', 'salary_calculations', v_id::text,
    jsonb_build_object('staff_id', p_staff_id, 'month', v_month, 'version_no', coalesce(v_prev.version_no, 0) + 1,
                       'payable_paise', (v->>'payable_paise')::bigint, 'overrides', v_ov));
  return v || jsonb_build_object('salary_calculation_id', v_id, 'version_no', coalesce(v_prev.version_no, 0) + 1);
end $$;

create or replace function private.preview_salary(p_rev integer, p_staff_id uuid, p_month date, p_overrides jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.manage');
  if p_month is null then perform private.fail('VALIDATION_ERROR', 'Choose a month'); end if;
  perform private.salary_overrides_check(p_overrides);
  return private.compute_salary(c.school_id, p_staff_id, p_month, p_overrides);
end $$;

-- Every staff member employed in the month: saved snapshot (+ live preview for managers)
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
    if v_manage then
      v_live := private.compute_salary(c.school_id, s.id, v_month, null);
      if v_saved.id is not null then
        v_cmp := private.compute_salary(c.school_id, s.id, v_month, v_saved.overrides);
      end if;
    end if;
    v_status := case
      when v_saved.id is not null and v_cmp is not null and (v_cmp->>'payable_paise')::bigint is distinct from v_saved.payable_paise then 'changed'
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
      'live', case when v_live is not null then jsonb_build_object(
                 'monthly_salary_paise', v_live->'monthly_salary_paise', 'working_days', v_live->'working_days',
                 'attended_days', v_live->'attended_days', 'paid_leave_days', v_live->'paid_leave_days',
                 'unpaid_days', v_live->'unpaid_days', 'payable_paise', v_live->'payable_paise',
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

drop function if exists public.record_paid_leave(integer, uuid, date, numeric, text);
create or replace function private.record_paid_leave(p_rev integer, p_staff_id uuid, p_leave_date date, p_day_fraction numeric,
                                                     p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_st app.staff; v_id uuid; v_w numeric;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.manage');
  select * into v_st from app.staff where id = p_staff_id and school_id = c.school_id;
  if v_st.id is null then perform private.fail('NOT_FOUND', 'Staff not found'); end if;
  if p_leave_date is null then perform private.fail('VALIDATION_ERROR', 'Choose the leave date'); end if;
  if coalesce(p_day_fraction, 1.0) not in (0.5, 1.0) then perform private.fail('VALIDATION_ERROR', 'Paid leave is a full day or a half day'); end if;
  if length(p_reason) > 500 then perform private.fail('VALIDATION_ERROR', 'Reason can be at most 500 characters'); end if;
  if p_leave_date < v_st.joined_on or (v_st.left_on is not null and p_leave_date > v_st.left_on) then
    perform private.fail('VALIDATION_ERROR', 'The staff member was not employed on that date');
  end if;
  v_w := coalesce((select weight from private.resolve_day(c.school_id, 'staff', v_st.staff_group_id, p_leave_date)), 0);
  if v_w = 0 then perform private.fail('VALIDATION_ERROR', 'That date is not a working day on this staff member''s calendar'); end if;
  if exists (select 1 from app.staff_paid_leave where staff_id = p_staff_id and leave_date = p_leave_date and status = 'active') then
    perform private.fail('DUPLICATE', 'Paid leave is already recorded for this day');
  end if;
  insert into app.staff_paid_leave (school_id, staff_id, leave_date, day_fraction, reason, recorded_by)
  values (c.school_id, p_staff_id, p_leave_date, coalesce(p_day_fraction, 1.0), nullif(btrim(p_reason), ''), c.account_id)
  returning id into v_id;
  perform private.log_event('salary.paid_leave.recorded', 'staff_paid_leave', v_id::text,
    jsonb_build_object('staff_id', p_staff_id, 'date', p_leave_date, 'fraction', coalesce(p_day_fraction, 1.0)));
  return jsonb_build_object('paid_leave_id', v_id,
    'note', case when exists (select 1 from app.staff_attendance where staff_id = p_staff_id and attendance_date = p_leave_date
                                and status in ('P','L'))
                 then 'Attendance for this day is already marked present; the calculator counts at most one day' end);
end $$;

create or replace function private.list_paid_leave(p_rev integer, p_staff_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.read');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('VALIDATION_ERROR', 'Choose a date range of up to 400 days');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'staff_id', pl.staff_id, 'name', st.full_name,
             'leave_date', pl.leave_date, 'day_fraction', pl.day_fraction, 'reason', pl.reason, 'status', pl.status,
             'recorded_by', (select display_name from app.accounts where id = pl.recorded_by), 'created_at', pl.created_at)
             order by pl.leave_date, st.full_name)
    from app.staff_paid_leave pl join app.staff st on st.id = pl.staff_id
   where pl.school_id = c.school_id and pl.leave_date between p_from and p_to
     and (p_staff_id is null or pl.staff_id = p_staff_id)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Attendance register: one section, one month (ATT-03)
-- -----------------------------------------------------------------------------
create or replace function private.get_attendance_register(p_rev integer, p_section_id uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_sec record; v_from date; v_to date; v_dates jsonb; v_students jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  if p_month is null then perform private.fail('VALIDATION_ERROR', 'Choose a month'); end if;
  select s.id, s.name, cl.name as class_name, s.academic_year_id into v_sec
    from app.sections s join app.classes cl on cl.id = s.class_id where s.id = p_section_id and s.school_id = c.school_id;
  if v_sec.id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  v_from := date_trunc('month', p_month)::date;
  v_to := least((v_from + interval '1 month - 1 day')::date, private.school_today(c.school_id));
  if not (private.has_cap('attendance.read_all')
          or (c.role = 'teacher' and exists (select 1 from app.teaching_assignments ta
                where ta.section_id = v_sec.id and ta.staff_id = c.staff_id and ta.kind = 'class_teacher'
                  and ta.effective_from <= (v_from + interval '1 month - 1 day')::date
                  and (ta.effective_to is null or ta.effective_to > v_from)))) then
    perform private.fail('FORBIDDEN', 'Only the class teacher, Principal or Admin can see this register');
  end if;
  if v_to < v_from then
    return jsonb_build_object('section_id', v_sec.id, 'section', v_sec.class_name || ' ' || v_sec.name, 'month', v_from,
                              'dates', '[]'::jsonb, 'students', '[]'::jsonb, 'note', 'This month has not started yet');
  end if;

  create temp table if not exists pg_temp.reg_days (d date primary key, weight numeric, day_type text, label text, mode text) on commit drop;
  truncate pg_temp.reg_days;
  insert into pg_temp.reg_days
  select g::date, coalesce(r.weight, 0), r.day_type, r.label, private.attendance_mode_on(c.school_id, g::date)
    from generate_series(v_from, v_to, interval '1 day') g
    left join lateral private.resolve_day(c.school_id, 'student', null, g::date) r on true;

  select jsonb_agg(jsonb_build_object('date', d, 'weekday', extract(isodow from d)::int, 'weight', weight,
                                      'day_type', coalesce(day_type, 'none'), 'label', label, 'mode', mode) order by d)
    into v_dates from pg_temp.reg_days;

  with placed as (   -- each student's eligible days in THIS section
    select p.student_id, rd.d, rd.mode, rd.weight
      from app.placements p
      join app.enrollments e on e.id = p.enrollment_id
      join pg_temp.reg_days rd on rd.d >= p.effective_from and (p.effective_to is null or rd.d < p.effective_to)
                              and rd.d >= e.joined_on and (e.left_on is null or rd.d <= e.left_on)
     where p.section_id = v_sec.id and rd.weight > 0
  ), cells as (
    select pl.student_id, pl.d, pl.mode,
           case when pl.mode = 'daily' then (select a.status::text from app.student_daily_attendance a
                                              where a.student_id = pl.student_id and a.attendance_date = pl.d) end as status,
           case when pl.mode = 'period' then (select count(*) from app.lesson_sessions ls
                                              where ls.section_id = v_sec.id and ls.session_date = pl.d and ls.status = 'scheduled') end as held,
           case when pl.mode = 'period' then (select count(*) from app.lesson_sessions ls join app.student_period_attendance pa
                                                on pa.lesson_session_id = ls.id and pa.student_id = pl.student_id
                                              where ls.section_id = v_sec.id and ls.session_date = pl.d and ls.status = 'scheduled') end as marked,
           case when pl.mode = 'period' then (select count(*) from app.lesson_sessions ls join app.student_period_attendance pa
                                                on pa.lesson_session_id = ls.id and pa.student_id = pl.student_id and pa.status in ('P','L')
                                              where ls.section_id = v_sec.id and ls.session_date = pl.d and ls.status = 'scheduled') end as attended
      from placed pl
  ), per_student as (
    select student_id,
           jsonb_object_agg(d::text, case when mode = 'daily' then jsonb_build_object('s', status)
                                          else jsonb_build_object('held', held, 'marked', marked, 'attended', attended) end) as cells,
           sum(case when mode = 'daily' then 1 else held end) as expected_units,
           sum(case when mode = 'daily' then (status is not null)::int else marked end) as marked_units,
           sum(case when mode = 'daily' then case status when 'P' then 1.0 when 'L' then 1.0 when 'H' then 0.5 else 0 end
                    else attended end) as attended_units
      from cells group by student_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'student_id', st.id, 'name', st.full_name, 'admission_no', st.admission_no,
           'roll_no', (select p.roll_no from app.placements p where p.student_id = st.id and p.section_id = v_sec.id
                        order by p.effective_from desc limit 1),
           'cells', ps.cells,
           'expected_units', ps.expected_units, 'marked_units', ps.marked_units, 'attended_units', ps.attended_units,
           'unmarked_units', ps.expected_units - ps.marked_units,
           'percentage', case when ps.marked_units > 0 then round(100.0 * ps.attended_units / ps.marked_units, 1) end,
           'is_final', ps.expected_units > 0 and ps.expected_units = ps.marked_units)
         order by (select p.roll_no from app.placements p where p.student_id = st.id and p.section_id = v_sec.id
                    order by p.effective_from desc limit 1) nulls last, st.full_name), '[]'::jsonb)
    into v_students
    from per_student ps join app.students st on st.id = ps.student_id;

  return jsonb_build_object('section_id', v_sec.id, 'section', v_sec.class_name || ' ' || v_sec.name,
    'month', v_from, 'to', v_to, 'dates', coalesce(v_dates, '[]'::jsonb), 'students', v_students,
    'legend', jsonb_build_object('daily', 'P present, L late, H half day, A absent, null = unmarked',
                                 'period', 'attended / held lessons that day; marked < held means some lessons are unmarked'));
end $$;

-- Correction trail: which mark changed, from what to what, by whom
create or replace function private.list_attendance_changes(p_rev integer, p_from date, p_to date, p_kind text,
                                                           p_section_id uuid, p_person_id uuid, p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_items jsonb;
begin
  select * into c from private.require_ctx(p_rev);
  if coalesce(p_kind, 'student') not in ('student','staff') then perform private.fail('VALIDATION_ERROR', 'Kind must be student or staff'); end if;
  if coalesce(p_kind, 'student') = 'staff' then perform private.require_cap('staff_attendance.read');
  else perform private.require_cap('attendance.read_all'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('VALIDATION_ERROR', 'Choose a date range of up to 400 days');
  end if;
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]'::jsonb) into v_items from (
    select jsonb_build_object('id', ch.id, 'kind', ch.kind, 'attendance_date', ch.attendance_date,
             'person_id', ch.person_id,
             'person', coalesce((select full_name from app.students where id = ch.person_id),
                                (select full_name from app.staff where id = ch.person_id)),
             'admission_no', (select admission_no from app.students where id = ch.person_id),
             'lesson_session_id', ch.lesson_session_id,
             'lesson', (select jsonb_build_object('slot_label', ls.slot_label, 'subject', sub.name)
                          from app.lesson_sessions ls join app.subjects sub on sub.id = ls.subject_id where ls.id = ch.lesson_session_id),
             'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id
                          where s.id = coalesce(sub_.section_id, (select section_id from app.lesson_sessions where id = ch.lesson_session_id))),
             'old_status', ch.old_status, 'new_status', ch.new_status,
             'changed_by', (select display_name from app.accounts where id = sub_.actor_id), 'changed_by_role', sub_.actor_role,
             'changed_at', sub_.created_at) as x
      from app.attendance_changes ch
      join app.attendance_submissions sub_ on sub_.id = ch.submission_id
     where ch.school_id = c.school_id and ch.attendance_date between p_from and p_to
       and (case when coalesce(p_kind, 'student') = 'staff' then ch.kind = 'staff' else ch.kind <> 'staff' end)
       and (p_person_id is null or ch.person_id = p_person_id)
       and (p_section_id is null or coalesce(sub_.section_id, (select section_id from app.lesson_sessions where id = ch.lesson_session_id)) = p_section_id)
       and (p_before_id is null or ch.id < p_before_id)
     order by ch.id desc limit v_limit) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = v_limit then (v_items->-1->>'id')::bigint end);
end $$;

-- -----------------------------------------------------------------------------
-- Academic coverage for the Principal (HW-03, dashboards): per section / subject / teacher
-- -----------------------------------------------------------------------------
create or replace function private.get_academic_coverage(p_rev integer, p_from date, p_to date, p_section_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_to date;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('academic.read_all');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform private.fail('VALIDATION_ERROR', 'Choose a date range of up to 63 days');
  end if;
  v_to := least(p_to, private.school_today(c.school_id));
  return jsonb_build_object('from', p_from, 'to', v_to, 'rows', coalesce((
    select jsonb_agg(r order by r->>'section', r->>'subject', r->>'teacher') from (
      select jsonb_build_object(
        'section_id', ls.section_id,
        'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = ls.section_id),
        'subject_id', ls.subject_id, 'subject', (select name from app.subjects where id = ls.subject_id),
        'staff_id', ls.actual_staff_id, 'teacher', coalesce((select full_name from app.staff where id = ls.actual_staff_id), 'Unassigned'),
        'lessons', count(*),
        'diary_written', count(*) filter (where exists (select 1 from app.diary_entries de where de.lesson_session_id = ls.id)),
        'period_lessons', count(*) filter (where private.attendance_mode_on(c.school_id, ls.session_date) = 'period'),
        'period_attendance_marked', count(*) filter (where private.attendance_mode_on(c.school_id, ls.session_date) = 'period'
                                       and exists (select 1 from app.student_period_attendance pa where pa.lesson_session_id = ls.id)),
        'homework_set', (select count(*) from app.homework_assignments h where h.lesson_session_id = any (array_agg(ls.id)) and h.status = 'active'),
        'homework_due', (select count(*) from app.homework_assignments h where h.lesson_session_id = any (array_agg(ls.id))
                           and h.status = 'active' and h.due_on <= private.school_today(c.school_id)),
        'homework_due_fully_checked', (select count(*) from app.homework_assignments h
                           where h.lesson_session_id = any (array_agg(ls.id)) and h.status = 'active'
                             and h.due_on <= private.school_today(c.school_id)
                             and (select count(*) from app.homework_checks hc where hc.assignment_id = h.id)
                                 >= (select count(*) from private.eligible_students(h.section_id, h.assigned_on))),
        'homework_due_unchecked', (select count(*) from app.homework_assignments h
                           where h.lesson_session_id = any (array_agg(ls.id)) and h.status = 'active'
                             and h.due_on <= private.school_today(c.school_id)
                             and not exists (select 1 from app.homework_checks hc where hc.assignment_id = h.id))) as r
        from app.lesson_sessions ls
       where ls.school_id = c.school_id and ls.status = 'scheduled' and ls.session_date between p_from and v_to
         and (p_section_id is null or ls.section_id = p_section_id)
       group by ls.section_id, ls.subject_id, ls.actual_staff_id) q), '[]'::jsonb),
    'note', 'Lessons = scheduled (not cancelled) lessons up to today. Fully checked = every eligible student has a check.');
end $$;

-- -----------------------------------------------------------------------------
-- Fee-head totals (FEE-06)
-- -----------------------------------------------------------------------------
create or replace function private.get_fee_head_report(p_rev integer, p_academic_year_id uuid, p_fee_term_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_year uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('fees.read');
  v_year := coalesce(p_academic_year_id, (select id from app.academic_years where school_id = c.school_id and is_current));
  if not exists (select 1 from app.academic_years where id = v_year and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  return jsonb_build_object('academic_year_id', v_year, 'fee_term_id', p_fee_term_id,
    'heads', coalesce((select jsonb_agg(x order by x->>'code') from (
      select jsonb_build_object('fee_head_id', h.id, 'code', h.code, 'name', h.name, 'kind', h.kind,
        'invoices', (select count(distinct l.invoice_id) from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
                      where l.fee_head_id = h.id and i.status = 'issued' and i.academic_year_id = v_year
                        and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)),
        'gross_paise', (select coalesce(sum(l.gross_paise), 0) from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
                      where l.fee_head_id = h.id and i.status = 'issued' and i.academic_year_id = v_year
                        and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)),
        'concession_paise', (select coalesce(sum(l.concession_paise), 0) from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
                      where l.fee_head_id = h.id and i.status = 'issued' and i.academic_year_id = v_year
                        and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)),
        'adjustments_paise', (select coalesce(sum(a.amount_paise), 0) from app.invoice_adjustments a join app.invoices i on i.id = a.invoice_id
                      where a.fee_head_id = h.id and i.status = 'issued' and i.academic_year_id = v_year
                        and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id))) as x
        from app.fee_heads h where h.school_id = c.school_id) q
       where (x->>'invoices')::int > 0 or (x->>'adjustments_paise')::bigint <> 0), '[]'::jsonb),
    'adjustments_without_head_paise', (select coalesce(sum(a.amount_paise), 0) from app.invoice_adjustments a join app.invoices i on i.id = a.invoice_id
                      where a.fee_head_id is null and a.school_id = c.school_id and i.status = 'issued' and i.academic_year_id = v_year
                        and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)),
    'totals', (select jsonb_build_object('charged_paise', coalesce(sum(b.charged_paise + b.adjustments_paise), 0),
                                         'paid_paise', coalesce(sum(b.allocated_paise - b.reversed_paise), 0),
                                         'balance_paise', coalesce(sum(b.balance_paise), 0))
                 from private.invoice_balances(c.school_id, null, v_year) b join app.invoices i on i.id = b.invoice_id
                where b.status = 'issued' and (p_fee_term_id is null or i.fee_term_id = p_fee_term_id)),
    'note', 'Payments are allocated to invoices, not to fee heads, so collections are shown in total only.');
end $$;

-- -----------------------------------------------------------------------------
-- Lessons on a date (TIME-02): time override and extra lessons
-- -----------------------------------------------------------------------------
drop function if exists public.update_lesson_session(integer, bigint, text, uuid, text, integer);
drop function if exists private.update_lesson_session(integer, bigint, text, uuid, text, integer);
create or replace function private.update_lesson_session(p_rev integer, p_lesson_session_id bigint, p_action text,
                                                         p_subject_id uuid, p_reason text, p_expected_version integer,
                                                         p_start_time time, p_end_time time)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_clash record;
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
  elsif p_action = 'change_time' then
    if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
      perform private.fail('VALIDATION_ERROR', 'Choose a start time and a later end time');
    end if;
    if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'A cancelled lesson''s time can''t change'); end if;
    select ls.slot_label, sub.name as subject into v_clash from app.lesson_sessions ls join app.subjects sub on sub.id = ls.subject_id
     where ls.section_id = v_ls.section_id and ls.session_date = v_ls.session_date and ls.status = 'scheduled' and ls.id <> v_ls.id
       and ls.start_time < p_end_time and p_start_time < ls.end_time limit 1;
    if v_clash.slot_label is not null then
      perform private.fail('VALIDATION_ERROR', 'That time overlaps ' || v_clash.subject || ' (' || v_clash.slot_label || ') for this section');
    end if;
    if v_ls.actual_staff_id is not null then
      select ls.slot_label, cl.name || ' ' || s.name as section into v_clash from app.lesson_sessions ls
        join app.sections s on s.id = ls.section_id join app.classes cl on cl.id = s.class_id
       where ls.actual_staff_id = v_ls.actual_staff_id and ls.session_date = v_ls.session_date and ls.status = 'scheduled'
         and ls.id <> v_ls.id and ls.start_time < p_end_time and p_start_time < ls.end_time limit 1;
      if v_clash.slot_label is not null then
        perform private.fail('VALIDATION_ERROR', 'The teacher has another lesson then (' || v_clash.section || ', ' || v_clash.slot_label || ')');
      end if;
    end if;
    update app.lesson_sessions set start_time = p_start_time, end_time = p_end_time, source = 'override' where id = v_ls.id;
  else
    perform private.fail('VALIDATION_ERROR', 'Unknown action');
  end if;
  perform private.log_event('timetable.lesson.' || p_action, 'lesson_sessions', v_ls.id::text,
                            jsonb_build_object('reason', p_reason, 'subject_id', p_subject_id, 'start_time', p_start_time, 'end_time', p_end_time));
  return jsonb_build_object('lesson_session_id', v_ls.id,
                            'version', (select version from app.lesson_sessions where id = v_ls.id));
end $$;


create or replace function private.add_extra_lesson(p_rev integer, p_section_id uuid, p_date date, p_start_time time, p_end_time time,
                                                    p_subject_id uuid, p_staff_id uuid, p_label text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_sec record; v_clash record; v_ord integer; v_id bigint; v_label text := coalesce(nullif(btrim(p_label), ''), 'Extra');
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select s.id, s.class_id, s.academic_year_id, ay.start_date, ay.end_date into v_sec
    from app.sections s join app.academic_years ay on ay.id = s.academic_year_id
   where s.id = p_section_id and s.school_id = c.school_id;
  if v_sec.id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  if p_date is null or p_date not between v_sec.start_date and v_sec.end_date then
    perform private.fail('VALIDATION_ERROR', 'The date must be inside the section''s academic year');
  end if;
  if coalesce((select weight from private.resolve_day(c.school_id, 'student', null, p_date)), 0) = 0 then
    perform private.fail('VALIDATION_ERROR', 'That date is not a working day for students');
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    perform private.fail('VALIDATION_ERROR', 'Choose a start time and a later end time');
  end if;
  if length(v_label) > 40 then perform private.fail('VALIDATION_ERROR', 'Label can be at most 40 characters'); end if;
  if length(p_reason) > 500 then perform private.fail('VALIDATION_ERROR', 'Reason can be at most 500 characters'); end if;
  if not exists (select 1 from app.class_subjects cs where cs.class_id = v_sec.class_id and cs.academic_year_id = v_sec.academic_year_id
                   and cs.subject_id = p_subject_id and cs.status = 'active') then
    perform private.fail('VALIDATION_ERROR', 'Choose a subject taught in this class');
  end if;
  if p_staff_id is not null and not exists (select 1 from app.staff where id = p_staff_id and school_id = c.school_id
                                              and status = 'active' and is_teaching) then
    perform private.fail('VALIDATION_ERROR', 'Choose an active teacher');
  end if;
  perform 1 from app.sections where id = v_sec.id for update;
  select ls.id into v_id from app.lesson_sessions ls
   where ls.section_id = v_sec.id and ls.session_date = p_date and ls.source = 'extra' and ls.status = 'scheduled'
     and ls.start_time = p_start_time and ls.subject_id = p_subject_id;
  if v_id is not null then
    perform private.fail('DUPLICATE', 'This extra lesson already exists', jsonb_build_object('lesson_session_id', v_id));
  end if;
  select ls.slot_label, sub.name as subject into v_clash from app.lesson_sessions ls join app.subjects sub on sub.id = ls.subject_id
   where ls.section_id = v_sec.id and ls.session_date = p_date and ls.status = 'scheduled'
     and ls.start_time < p_end_time and p_start_time < ls.end_time limit 1;
  if v_clash.slot_label is not null then
    perform private.fail('VALIDATION_ERROR', 'That time overlaps ' || v_clash.subject || ' (' || v_clash.slot_label || ') for this section');
  end if;
  if p_staff_id is not null then
    select ls.slot_label, cl.name || ' ' || s.name as section into v_clash from app.lesson_sessions ls
      join app.sections s on s.id = ls.section_id join app.classes cl on cl.id = s.class_id
     where ls.actual_staff_id = p_staff_id and ls.session_date = p_date and ls.status = 'scheduled'
       and ls.start_time < p_end_time and p_start_time < ls.end_time limit 1;
    if v_clash.slot_label is not null then
      perform private.fail('VALIDATION_ERROR', 'The teacher has another lesson then (' || v_clash.section || ', ' || v_clash.slot_label || ')');
    end if;
  end if;
  -- extra lessons take the highest free slot number (20, 19, …) so a timetable period never collides with one
  select max(g) into v_ord from generate_series(1, 20) g
   where not exists (select 1 from app.lesson_sessions where section_id = v_sec.id and session_date = p_date and slot_ordinal = g)
     and g > coalesce((select max(ordinal) from app.schedule_slots ss join app.period_schedules ps on ps.id = ss.period_schedule_id
                        where ps.school_id = c.school_id), 0);
  if v_ord is null then perform private.fail('LIMIT_REACHED', 'Too many lessons on this date'); end if;
  insert into app.lesson_sessions (school_id, academic_year_id, section_id, session_date, slot_ordinal, slot_label,
                                   start_time, end_time, subject_id, planned_staff_id, actual_staff_id, source)
  values (c.school_id, v_sec.academic_year_id, v_sec.id, p_date, v_ord, v_label, p_start_time, p_end_time,
          p_subject_id, p_staff_id, p_staff_id, 'extra')
  returning id into v_id;
  perform private.log_event('timetable.lesson.extra_added', 'lesson_sessions', v_id::text,
    jsonb_build_object('section_id', v_sec.id, 'date', p_date, 'subject_id', p_subject_id, 'staff_id', p_staff_id, 'reason', p_reason));
  return jsonb_build_object('lesson_session_id', v_id, 'slot_ordinal', v_ord,
                            'version', (select version from app.lesson_sessions where id = v_id));
end $$;

-- -----------------------------------------------------------------------------
-- Home-screen summary: each block appears only for a role that has its capability
-- -----------------------------------------------------------------------------
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
      'due_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, null, null)),
      'overdue_paise', (select coalesce(sum(balance_paise), 0) from private.invoice_balances(c.school_id, null, null) b
                          where b.due_date < v_today),
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

-- -----------------------------------------------------------------------------
-- Maintenance: retention cleanup + idle app-session expiry, run daily (pg_cron) or by the Operator
-- -----------------------------------------------------------------------------
create table if not exists private.maintenance_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  trigger     text not null check (trigger in ('schedule','operator')),
  result      jsonb not null
);
revoke all on private.maintenance_runs from public, anon, authenticated;

create or replace function private.run_maintenance(p_trigger text default 'schedule')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t integer; v_u integer; v_a integer; v_s integer; v_res jsonb;
begin
  delete from private.telemetry_events where id in (
    select id from private.telemetry_events
     where received_at < now() - make_interval(days => (select days from private.retention_settings where key = 'telemetry_days'))
     limit 50000);
  get diagnostics v_t = row_count;
  delete from private.usage_daily
   where day < current_date - (select days from private.retention_settings where key = 'usage_daily_days');
  get diagnostics v_u = row_count;
  delete from private.auth_events where id in (
    select id from private.auth_events
     where occurred_at < now() - make_interval(days => (select days from private.retention_settings where key = 'auth_events_days'))
     limit 50000);
  get diagnostics v_a = row_count;
  -- app sessions not seen for 30 days end; the next visit asks for a fresh sign-in
  update private.app_sessions set ended_at = now(), end_reason = 'expired'
   where ended_at is null and last_seen_at < now() - interval '30 days';
  get diagnostics v_s = row_count;
  v_res := jsonb_build_object('telemetry_deleted', v_t, 'usage_daily_deleted', v_u, 'auth_events_deleted', v_a,
                              'sessions_expired', v_s);
  insert into private.maintenance_runs (trigger, result) values (coalesce(p_trigger, 'schedule'), v_res);
  delete from private.maintenance_runs where ran_at < now() - interval '400 days';
  return v_res;
end $$;
revoke execute on function private.run_maintenance(text) from public, anon, authenticated;

create or replace function private.op_run_retention_cleanup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_operator();
  v := private.run_maintenance('operator');
  perform private.log_event('operator.retention_cleanup', 'private', null, v);
  return v;
end $$;

create or replace function private.op_get_maintenance()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cron jsonb;
begin
  perform private.require_operator();
  if to_regclass('cron.job') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
                from cron.job where jobname = 'primecampus-maintenance'$q$ into v_cron;
  end if;
  return jsonb_build_object(
    'retention', (select jsonb_agg(jsonb_build_object('key', key, 'days', days, 'updated_at', updated_at) order by key)
                    from private.retention_settings),
    'schedule', coalesce(v_cron, '[]'::jsonb),
    'scheduled', coalesce(jsonb_array_length(v_cron), 0) > 0,
    'runs', coalesce((select jsonb_agg(jsonb_build_object('ran_at', ran_at, 'trigger', trigger, 'result', result) order by ran_at desc)
                        from (select * from private.maintenance_runs order by ran_at desc limit 30) r), '[]'::jsonb),
    'open_sessions', (select count(*) from private.app_sessions where ended_at is null));
end $$;

-- Daily at 02:30 IST (21:00 UTC) where pg_cron is available; skipped elsewhere (local tests)
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      execute 'create extension if not exists pg_cron';
      execute $c$select cron.schedule('primecampus-maintenance', '0 21 * * *', $j$select private.run_maintenance('schedule')$j$)$c$;
    exception when others then
      raise notice 'pg_cron not scheduled: %', sqlerrm;
    end;
  end if;
end $do$;

-- -----------------------------------------------------------------------------
-- Public wrappers
-- -----------------------------------------------------------------------------
create or replace function public.get_salary_month(p_ctx_rev integer, p_month date, p_staff_group_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_salary_month(p_ctx_rev, p_month, p_staff_group_id) $$;
create or replace function public.record_paid_leave(p_ctx_rev integer, p_staff_id uuid, p_leave_date date, p_day_fraction numeric default 1.0, p_reason text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.record_paid_leave(p_ctx_rev, p_staff_id, p_leave_date, p_day_fraction, p_reason) $$;
create or replace function public.list_paid_leave(p_ctx_rev integer, p_from date, p_to date, p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_paid_leave(p_ctx_rev, p_staff_id, p_from, p_to) $$;
create or replace function public.get_attendance_register(p_ctx_rev integer, p_section_id uuid, p_month date)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_attendance_register(p_ctx_rev, p_section_id, p_month) $$;
create or replace function public.list_attendance_changes(p_ctx_rev integer, p_from date, p_to date, p_kind text default 'student', p_section_id uuid default null, p_person_id uuid default null, p_before_id bigint default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.list_attendance_changes(p_ctx_rev, p_from, p_to, p_kind, p_section_id, p_person_id, p_before_id, p_limit) $$;
create or replace function public.get_academic_coverage(p_ctx_rev integer, p_from date, p_to date, p_section_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_academic_coverage(p_ctx_rev, p_from, p_to, p_section_id) $$;
create or replace function public.get_fee_head_report(p_ctx_rev integer, p_academic_year_id uuid default null, p_fee_term_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_fee_head_report(p_ctx_rev, p_academic_year_id, p_fee_term_id) $$;
create or replace function public.update_lesson_session(p_ctx_rev integer, p_lesson_session_id bigint, p_action text, p_subject_id uuid default null, p_reason text default null, p_expected_version integer default null, p_start_time time default null, p_end_time time default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.update_lesson_session(p_ctx_rev, p_lesson_session_id, p_action, p_subject_id, p_reason, p_expected_version, p_start_time, p_end_time) $$;
create or replace function public.add_extra_lesson(p_ctx_rev integer, p_section_id uuid, p_date date, p_start_time time, p_end_time time, p_subject_id uuid, p_staff_id uuid default null, p_label text default null, p_reason text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.add_extra_lesson(p_ctx_rev, p_section_id, p_date, p_start_time, p_end_time, p_subject_id, p_staff_id, p_label, p_reason) $$;
create or replace function public.get_dashboard(p_ctx_rev integer, p_date date default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_dashboard(p_ctx_rev, p_date) $$;
create or replace function public.op_get_maintenance()
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_get_maintenance() $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
revoke execute on function private.run_maintenance(text) from authenticated;
grant execute on function
  private.salary_overrides_check(jsonb),
  private.save_salary_calculation(integer, uuid, date, jsonb, text),
  private.preview_salary(integer, uuid, date, jsonb),
  private.get_salary_month(integer, date, uuid),
  private.record_paid_leave(integer, uuid, date, numeric, text),
  private.list_paid_leave(integer, uuid, date, date),
  private.get_attendance_register(integer, uuid, date),
  private.list_attendance_changes(integer, date, date, text, uuid, uuid, bigint, integer),
  private.get_academic_coverage(integer, date, date, uuid),
  private.get_fee_head_report(integer, uuid, uuid),
  private.update_lesson_session(integer, bigint, text, uuid, text, integer, time, time),
  private.add_extra_lesson(integer, uuid, date, time, time, uuid, uuid, text, text),
  private.get_dashboard(integer, date),
  private.op_run_retention_cleanup(), private.op_get_maintenance()
to authenticated;
grant execute on function
  public.get_salary_month(integer, date, uuid),
  public.record_paid_leave(integer, uuid, date, numeric, text),
  public.list_paid_leave(integer, date, date, uuid),
  public.get_attendance_register(integer, uuid, date),
  public.list_attendance_changes(integer, date, date, text, uuid, uuid, bigint, integer),
  public.get_academic_coverage(integer, date, date, uuid),
  public.get_fee_head_report(integer, uuid, uuid),
  public.update_lesson_session(integer, bigint, text, uuid, text, integer, time, time),
  public.add_extra_lesson(integer, uuid, date, time, time, uuid, uuid, text, text),
  public.get_dashboard(integer, date),
  public.op_get_maintenance()
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
