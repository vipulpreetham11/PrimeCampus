-- =============================================================================
-- PrimeCampus V1 — 1300 Setup / master-data RPCs and role-shaped reads
--
-- These are SECURITY INVOKER: they run as the caller, so the RLS policies from
-- 0800 are the enforcement layer (defense in depth); each also checks the
-- capability first to return a clean FORBIDDEN instead of an RLS error.
-- =============================================================================

grant execute on function private.require_ctx(integer), private.require_cap(text),
                          private.fail(text, text, jsonb) to authenticated;

-- Shared: optimistic update guard
create or replace function private.check_updated(p_found boolean, p_what text)
returns void language plpgsql set search_path = '' as $$
begin
  if not p_found then
    perform private.fail('CONFLICT', p_what || ' changed since you opened it, or does not exist. Reload and retry.');
  end if;
end $$;
grant execute on function private.check_updated(boolean, text) to authenticated;

-- =============================================================================
-- School & academic setup
-- =============================================================================
create or replace function public.save_school_profile(p_ctx_rev integer, p jsonb, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  update app.schools set
    name = coalesce(p->>'name', name), udise_code = case when p ? 'udise_code' then p->>'udise_code' else udise_code end,
    board = case when p ? 'board' then p->>'board' else board end,
    affiliation_no = case when p ? 'affiliation_no' then p->>'affiliation_no' else affiliation_no end,
    phone = case when p ? 'phone' then p->>'phone' else phone end, email = case when p ? 'email' then p->>'email' else email end,
    address_line = case when p ? 'address_line' then p->>'address_line' else address_line end,
    city = case when p ? 'city' then p->>'city' else city end, district = case when p ? 'district' then p->>'district' else district end,
    pincode = case when p ? 'pincode' then p->>'pincode' else pincode end,
    logo_url = case when p ? 'logo_url' then p->>'logo_url' else logo_url end
  where id = c.school_id and version = p_expected_version returning version into v;
  perform private.check_updated(v is not null, 'School profile');
  return jsonb_build_object('school_id', c.school_id, 'version', v);
end $$;

create or replace function public.save_academic_year(p_ctx_rev integer, p_name text, p_start_date date, p_end_date date,
                                                     p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_id is null then
    insert into app.academic_years (school_id, name, start_date, end_date) values (c.school_id, p_name, p_start_date, p_end_date)
    returning id, version into v_id, v;
  else
    update app.academic_years set name = p_name, start_date = p_start_date, end_date = p_end_date
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Academic year');
  end if;
  return jsonb_build_object('academic_year_id', v_id, 'version', v);
end $$;

-- Selecting the current year never promotes students or hides old dues (PRD SETUP-03)
create or replace function public.set_current_year(p_ctx_rev integer, p_academic_year_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  update app.academic_years set is_current = false where school_id = c.school_id and is_current and id <> p_academic_year_id;
  update app.academic_years set is_current = true where id = p_academic_year_id;
  return jsonb_build_object('academic_year_id', p_academic_year_id, 'is_current', true);
end $$;

create or replace function public.save_class(p_ctx_rev integer, p_name text, p_sort_order integer, p_status text default 'active',
                                             p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_id is null then
    insert into app.classes (school_id, name, sort_order, status) values (c.school_id, p_name, p_sort_order, p_status)
    returning id, version into v_id, v;
  else
    update app.classes set name = p_name, sort_order = p_sort_order, status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Class');
  end if;
  return jsonb_build_object('class_id', v_id, 'version', v);
end $$;

create or replace function public.save_section(p_ctx_rev integer, p_academic_year_id uuid, p_class_id uuid, p_name text,
                                               p_capacity integer default null, p_sort_order integer default 0,
                                               p_status text default 'active', p_id uuid default null,
                                               p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_id is null then
    insert into app.sections (school_id, academic_year_id, class_id, name, capacity, sort_order, status)
    values (c.school_id, p_academic_year_id, p_class_id, p_name, p_capacity, p_sort_order, p_status)
    returning id, version into v_id, v;
  else
    update app.sections set name = p_name, capacity = p_capacity, sort_order = p_sort_order, status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Section');
  end if;
  return jsonb_build_object('section_id', v_id, 'version', v);
end $$;

create or replace function public.save_subject(p_ctx_rev integer, p_name text, p_code text, p_status text default 'active',
                                               p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_id is null then
    insert into app.subjects (school_id, name, code, status) values (c.school_id, p_name, p_code, p_status)
    returning id, version into v_id, v;
  else
    update app.subjects set name = p_name, code = p_code, status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Subject');
  end if;
  return jsonb_build_object('subject_id', v_id, 'version', v);
end $$;

-- Replace the subject list of a class for a year: listed subjects active, others retired
create or replace function public.save_class_subjects(p_ctx_rev integer, p_academic_year_id uuid, p_class_id uuid, p_subjects jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  insert into app.class_subjects (school_id, academic_year_id, class_id, subject_id, is_optional, sort_order, status)
  select c.school_id, p_academic_year_id, p_class_id, (x->>'subject_id')::uuid,
         coalesce((x->>'is_optional')::boolean, false), coalesce((x->>'sort_order')::smallint, 0), 'active'
    from jsonb_array_elements(p_subjects) x
  on conflict (academic_year_id, class_id, subject_id)
  do update set is_optional = excluded.is_optional, sort_order = excluded.sort_order, status = 'active';
  update app.class_subjects set status = 'retired'
   where school_id = c.school_id and academic_year_id = p_academic_year_id and class_id = p_class_id and status = 'active'
     and subject_id not in (select (x->>'subject_id')::uuid from jsonb_array_elements(p_subjects) x);
  return jsonb_build_object('count', jsonb_array_length(p_subjects));
end $$;

-- New bell-schedule version. A new *regular* schedule closes the previous one; old
-- lessons keep the times they were created with (PRD SETUP-02).
-- p_slots: [{ordinal, label, kind: period|break, start_time, end_time}]
create or replace function public.save_period_schedule(p_ctx_rev integer, p_name text, p_kind text, p_day_start time,
                                                       p_day_end time, p_effective_from date, p_slots jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if exists (select 1 from jsonb_array_elements(p_slots) x
              where (x->>'start_time')::time < p_day_start or (x->>'end_time')::time > p_day_end) then
    perform private.fail('VALIDATION_ERROR', 'Every period/break must sit inside the school day');
  end if;
  if p_kind = 'regular' then
    update app.period_schedules set effective_to = p_effective_from
     where school_id = c.school_id and kind = 'regular' and status = 'active'
       and effective_from < p_effective_from and (effective_to is null or effective_to > p_effective_from);
  end if;
  insert into app.period_schedules (school_id, name, kind, day_start, day_end, effective_from)
  values (c.school_id, p_name, p_kind, p_day_start, p_day_end, p_effective_from) returning id into v_id;
  insert into app.schedule_slots (school_id, period_schedule_id, ordinal, label, kind, start_time, end_time)
  select c.school_id, v_id, (x->>'ordinal')::smallint, x->>'label', x->>'kind', (x->>'start_time')::time, (x->>'end_time')::time
    from jsonb_array_elements(p_slots) x;
  return jsonb_build_object('period_schedule_id', v_id);
end $$;

-- Bulk-set a date range (optionally only certain ISO weekdays). Returns recorded
-- attendance on affected dates so past changes are deliberate, not silent.
create or replace function public.save_calendar_range(p_ctx_rev integer, p_academic_year_id uuid, p_audience text,
                                                      p_from date, p_to date, p_day_type text,
                                                      p_staff_group_id uuid default null, p_period_schedule_id uuid default null,
                                                      p_label text default null, p_reason text default null,
                                                      p_is_exam_day boolean default false, p_weekdays integer[] default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_n integer; v_affected bigint;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_to < p_from or p_to - p_from > 400 then perform private.fail('VALIDATION_ERROR', 'Invalid date range'); end if;
  insert into app.calendar_days (school_id, academic_year_id, audience, staff_group_id, cal_date, day_type,
                                 period_schedule_id, label, reason, is_exam_day, created_by)
  select c.school_id, p_academic_year_id, p_audience, p_staff_group_id, d::date, p_day_type, p_period_schedule_id,
         p_label, p_reason, coalesce(p_is_exam_day, false), auth.uid()
    from generate_series(p_from, p_to, interval '1 day') d
   where p_weekdays is null or extract(isodow from d)::integer = any (p_weekdays)
  on conflict on constraint calendar_days_date_uq do update
    set day_type = excluded.day_type, period_schedule_id = excluded.period_schedule_id, label = excluded.label,
        reason = excluded.reason, is_exam_day = excluded.is_exam_day;
  get diagnostics v_n = row_count;
  if p_audience = 'student' then
    select (select count(*) from app.student_daily_attendance where school_id = c.school_id and attendance_date between p_from and p_to)
         + (select count(*) from app.student_period_attendance where school_id = c.school_id and attendance_date between p_from and p_to)
      into v_affected;
  else
    select count(*) into v_affected from app.staff_attendance where school_id = c.school_id and attendance_date between p_from and p_to;
  end if;
  return jsonb_build_object('dates_saved', v_n, 'existing_attendance_marks_in_range', v_affected,
                            'note', case when v_affected > 0 and p_day_type in ('holiday','weekly_off')
                                         then 'Marks already recorded on these dates are kept but no longer count toward percentages.' end);
end $$;

-- p_patterns: [{weekday 1-7, day_type, period_schedule_id}]
create or replace function public.save_calendar_pattern(p_ctx_rev integer, p_academic_year_id uuid, p_audience text,
                                                        p_patterns jsonb, p_staff_group_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  insert into app.calendar_patterns (school_id, academic_year_id, audience, staff_group_id, weekday, day_type, period_schedule_id)
  select c.school_id, p_academic_year_id, p_audience, p_staff_group_id, (x->>'weekday')::smallint, x->>'day_type',
         (x->>'period_schedule_id')::uuid
    from jsonb_array_elements(p_patterns) x
  on conflict on constraint calendar_patterns_slot_uq do update
    set day_type = excluded.day_type, period_schedule_id = excluded.period_schedule_id;
  return jsonb_build_object('count', jsonb_array_length(p_patterns));
end $$;

create or replace function public.set_attendance_mode(p_ctx_rev integer, p_mode text, p_effective_from date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_effective_from < private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'A mode change cannot start in the past (history is never rewritten)');
  end if;
  insert into app.attendance_modes (school_id, mode, effective_from, created_by)
  values (c.school_id, p_mode, p_effective_from, auth.uid());
  return jsonb_build_object('mode', p_mode, 'effective_from', p_effective_from);
end $$;

-- =============================================================================
-- Staff
-- =============================================================================
create or replace function public.save_staff_group(p_ctx_rev integer, p_name text, p_status text default 'active',
                                                   p_default_salary_paise bigint default null,
                                                   p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_id is null then
    insert into app.staff_groups (school_id, name, status) values (c.school_id, p_name, p_status) returning id, version into v_id, v;
  else
    update app.staff_groups set name = p_name, status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Staff group');
  end if;
  if p_default_salary_paise is not null then
    perform private.require_cap('staff_finance.manage');
    insert into app.staff_group_salary_defaults (staff_group_id, school_id, monthly_salary_paise, updated_by)
    values (v_id, c.school_id, p_default_salary_paise, auth.uid())
    on conflict (staff_group_id) do update set monthly_salary_paise = excluded.monthly_salary_paise,
                                               updated_by = excluded.updated_by, updated_at = now();
  end if;
  return jsonb_build_object('staff_group_id', v_id, 'version', v);
end $$;

-- p: {employee_no, full_name, gender, phone, email, staff_group_id, designation, is_teaching, joined_on, left_on, status}
create or replace function public.save_staff(p_ctx_rev integer, p jsonb, p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff.manage');
  if p_id is null then
    insert into app.staff (school_id, employee_no, full_name, gender, phone, email, staff_group_id, designation,
                           is_teaching, joined_on, created_by)
    values (c.school_id, p->>'employee_no', p->>'full_name', p->>'gender', p->>'phone', p->>'email',
            (p->>'staff_group_id')::uuid, p->>'designation', coalesce((p->>'is_teaching')::boolean, false),
            (p->>'joined_on')::date, auth.uid())
    returning id, version into v_id, v;
  else
    update app.staff set
      employee_no = coalesce(p->>'employee_no', employee_no), full_name = coalesce(p->>'full_name', full_name),
      gender = case when p ? 'gender' then p->>'gender' else gender end,
      phone = case when p ? 'phone' then p->>'phone' else phone end, email = case when p ? 'email' then p->>'email' else email end,
      staff_group_id = coalesce((p->>'staff_group_id')::uuid, staff_group_id),
      designation = case when p ? 'designation' then p->>'designation' else designation end,
      is_teaching = coalesce((p->>'is_teaching')::boolean, is_teaching),
      joined_on = coalesce((p->>'joined_on')::date, joined_on),
      left_on = case when p ? 'left_on' then (p->>'left_on')::date else left_on end,
      status = coalesce(p->>'status', status)
    where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Staff record');
  end if;
  return jsonb_build_object('staff_id', v_id, 'version', v);
end $$;

-- Confidential: salary rate history + reference bank details (Admin/Operator write; Owner reads)
create or replace function public.save_staff_finance(p_ctx_rev integer, p_staff_id uuid, p_monthly_salary_paise bigint default null,
                                                     p_effective_from date default null, p_reason text default null,
                                                     p_bank jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff_finance.manage');
  if p_monthly_salary_paise is not null then
    insert into app.staff_salary_rates (school_id, staff_id, monthly_salary_paise, effective_from, reason, created_by)
    values (c.school_id, p_staff_id, p_monthly_salary_paise, p_effective_from, p_reason, auth.uid());
  end if;
  if p_bank is not null then
    insert into app.staff_bank_accounts (staff_id, school_id, account_holder_name, account_number, ifsc, bank_name, updated_by)
    values (p_staff_id, c.school_id, p_bank->>'account_holder_name', p_bank->>'account_number', upper(p_bank->>'ifsc'),
            p_bank->>'bank_name', auth.uid())
    on conflict (staff_id) do update set account_holder_name = excluded.account_holder_name,
      account_number = excluded.account_number, ifsc = excluded.ifsc, bank_name = excluded.bank_name,
      updated_by = excluded.updated_by;
  end if;
  return jsonb_build_object('staff_id', p_staff_id);
end $$;

create or replace function public.get_staff_confidential(p_ctx_rev integer, p_staff_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff_finance.read');
  return jsonb_build_object(
    'salary_rates', coalesce((select jsonb_agg(jsonb_build_object('monthly_salary_paise', monthly_salary_paise,
                               'effective_from', effective_from, 'reason', reason) order by effective_from desc)
                               from app.staff_salary_rates where staff_id = p_staff_id and school_id = c.school_id), '[]'),
    'bank', (select jsonb_build_object('account_holder_name', account_holder_name, 'account_number', account_number,
                                       'ifsc', ifsc, 'bank_name', bank_name)
               from app.staff_bank_accounts where staff_id = p_staff_id and school_id = c.school_id));
end $$;

create or replace function public.record_paid_leave(p_ctx_rev integer, p_staff_id uuid, p_leave_date date,
                                                    p_day_fraction numeric default 1.0, p_reason text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff_finance.manage');
  insert into app.staff_paid_leave (school_id, staff_id, leave_date, day_fraction, reason, recorded_by)
  values (c.school_id, p_staff_id, p_leave_date, p_day_fraction, p_reason, auth.uid()) returning id into v_id;
  return jsonb_build_object('paid_leave_id', v_id);
end $$;

create or replace function public.cancel_paid_leave(p_ctx_rev integer, p_paid_leave_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff_finance.manage');
  update app.staff_paid_leave set status = 'cancelled' where id = p_paid_leave_id and school_id = c.school_id and status = 'active'
  returning id into v_id;
  perform private.check_updated(v_id is not null, 'Paid leave');
  return jsonb_build_object('paid_leave_id', v_id, 'status', 'cancelled');
end $$;

create or replace function public.save_teaching_assignment(p_ctx_rev integer, p_section_id uuid, p_staff_id uuid, p_kind text,
                                                           p_effective_from date, p_subject_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  insert into app.teaching_assignments (school_id, academic_year_id, section_id, staff_id, kind, subject_id, effective_from, created_by)
  select c.school_id, s.academic_year_id, s.id, p_staff_id, p_kind, p_subject_id, p_effective_from, auth.uid()
    from app.sections s where s.id = p_section_id and s.school_id = c.school_id
  returning id into v_id;
  if v_id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  return jsonb_build_object('teaching_assignment_id', v_id);
end $$;

create or replace function public.end_teaching_assignment(p_ctx_rev integer, p_teaching_assignment_id uuid, p_effective_to date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  update app.teaching_assignments set effective_to = p_effective_to
   where id = p_teaching_assignment_id and school_id = c.school_id and effective_from < p_effective_to
     and (effective_to is null or effective_to > p_effective_to)
  returning id into v_id;
  perform private.check_updated(v_id is not null, 'Teaching assignment');
  return jsonb_build_object('teaching_assignment_id', v_id, 'effective_to', p_effective_to);
end $$;

-- =============================================================================
-- Timetable versions
-- =============================================================================
-- Teacher time clashes against other sections' active plans on the same weekday
create or replace function private.timetable_conflicts(p_version_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('weekday', te.weekday, 'slot_ordinal', te.slot_ordinal,
            'staff_id', te.staff_id, 'clashes_with_section_id', ov.section_id, 'other_slot_ordinal', ote.slot_ordinal)), '[]')
    from app.timetable_versions tv
    join app.timetable_entries te on te.timetable_version_id = tv.id and te.staff_id is not null
    join app.schedule_slots ss on ss.period_schedule_id = tv.period_schedule_id and ss.ordinal = te.slot_ordinal
    join app.timetable_versions ov on ov.school_id = tv.school_id and ov.status = 'active' and ov.section_id <> tv.section_id
         and ov.effective_from < coalesce(tv.effective_to, 'infinity'::date)
         and coalesce(ov.effective_to, 'infinity'::date) > tv.effective_from
    join app.timetable_entries ote on ote.timetable_version_id = ov.id and ote.staff_id = te.staff_id and ote.weekday = te.weekday
    join app.schedule_slots oss on oss.period_schedule_id = ov.period_schedule_id and oss.ordinal = ote.slot_ordinal
   where tv.id = p_version_id
     and ss.start_time < oss.end_time and ss.end_time > oss.start_time
$$;
grant execute on function private.timetable_conflicts(uuid) to authenticated;

-- Create or replace a draft. p_entries: [{weekday, slot_ordinal, subject_id, staff_id}]
create or replace function public.save_timetable_draft(p_ctx_rev integer, p_section_id uuid, p_period_schedule_id uuid,
                                                       p_effective_from date, p_entries jsonb, p_version_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v_bad integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  if p_version_id is null then
    insert into app.timetable_versions (school_id, academic_year_id, section_id, period_schedule_id, effective_from, created_by)
    select c.school_id, s.academic_year_id, s.id, p_period_schedule_id, p_effective_from, auth.uid()
      from app.sections s where s.id = p_section_id and s.school_id = c.school_id
    returning id into v_id;
    if v_id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  else
    update app.timetable_versions set period_schedule_id = p_period_schedule_id, effective_from = p_effective_from
     where id = p_version_id and school_id = c.school_id and status = 'draft' returning id into v_id;
    if v_id is null then perform private.fail('VALIDATION_ERROR', 'Only draft timetables can be edited; create a new version'); end if;
    delete from app.timetable_entries where timetable_version_id = v_id;
  end if;
  -- entries may only use period slots of the chosen schedule (breaks never get subjects)
  select count(*) into v_bad from jsonb_array_elements(p_entries) x
   where not exists (select 1 from app.schedule_slots ss where ss.period_schedule_id = p_period_schedule_id
                       and ss.ordinal = (x->>'slot_ordinal')::smallint and ss.kind = 'period');
  if v_bad > 0 then perform private.fail('VALIDATION_ERROR', 'Some entries are on breaks or unknown periods'); end if;
  insert into app.timetable_entries (school_id, timetable_version_id, weekday, slot_ordinal, subject_id, staff_id)
  select c.school_id, v_id, (x->>'weekday')::smallint, (x->>'slot_ordinal')::smallint, (x->>'subject_id')::uuid,
         (x->>'staff_id')::uuid
    from jsonb_array_elements(p_entries) x;
  return jsonb_build_object('timetable_version_id', v_id, 'conflicts', private.timetable_conflicts(v_id),
    'unassigned_periods', (select count(*) from app.schedule_slots ss
                            cross join generate_series(1, 6) wd
                            where ss.period_schedule_id = p_period_schedule_id and ss.kind = 'period'
                              and not exists (select 1 from app.timetable_entries te where te.timetable_version_id = v_id
                                                and te.weekday = wd and te.slot_ordinal = ss.ordinal)));
end $$;

create or replace function public.activate_timetable(p_ctx_rev integer, p_version_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v app.timetable_versions; v_conf jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  select * into v from app.timetable_versions where id = p_version_id and school_id = c.school_id and status = 'draft' for update;
  if not found then perform private.fail('NOT_FOUND', 'Draft timetable not found'); end if;
  v_conf := private.timetable_conflicts(v.id);
  if jsonb_array_length(v_conf) > 0 then
    perform private.fail('CONFLICT', 'A teacher is double-booked in this timetable', v_conf);
  end if;
  update app.timetable_versions set effective_to = v.effective_from
   where section_id = v.section_id and status = 'active' and effective_from < v.effective_from
     and (effective_to is null or effective_to > v.effective_from);
  update app.timetable_versions set status = 'retired'
   where section_id = v.section_id and status = 'active' and effective_from >= v.effective_from;
  update app.timetable_versions set status = 'active' where id = v.id;
  return jsonb_build_object('timetable_version_id', v.id, 'status', 'active',
                            'next_step', 'Generate lesson sessions for upcoming dates');
end $$;

create or replace function public.copy_timetable(p_ctx_rev integer, p_from_version_id uuid, p_target_section_id uuid,
                                                 p_effective_from date, p_keep_teachers boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_src app.timetable_versions; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  select * into v_src from app.timetable_versions where id = p_from_version_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Source timetable not found'); end if;
  insert into app.timetable_versions (school_id, academic_year_id, section_id, period_schedule_id, effective_from,
                                      copied_from_id, created_by)
  select c.school_id, s.academic_year_id, s.id, v_src.period_schedule_id, p_effective_from, v_src.id, auth.uid()
    from app.sections s where s.id = p_target_section_id and s.school_id = c.school_id returning id into v_id;
  if v_id is null then perform private.fail('NOT_FOUND', 'Target section not found'); end if;
  insert into app.timetable_entries (school_id, timetable_version_id, weekday, slot_ordinal, subject_id, staff_id)
  select c.school_id, v_id, weekday, slot_ordinal, subject_id, case when p_keep_teachers then staff_id end
    from app.timetable_entries where timetable_version_id = v_src.id;
  return jsonb_build_object('timetable_version_id', v_id, 'status', 'draft',
                            'conflicts', private.timetable_conflicts(v_id));
end $$;

-- =============================================================================
-- Fee configuration
-- =============================================================================
create or replace function public.save_fee_head(p_ctx_rev integer, p_name text, p_code text, p_kind text default 'regular',
                                                p_is_optional boolean default false, p_status text default 'active',
                                                p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if p_id is null then
    insert into app.fee_heads (school_id, name, code, kind, is_optional, status)
    values (c.school_id, p_name, p_code, p_kind, p_is_optional, p_status) returning id, version into v_id, v;
  else
    update app.fee_heads set name = p_name, code = p_code, is_optional = p_is_optional, status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Fee head');
  end if;
  return jsonb_build_object('fee_head_id', v_id, 'version', v);
end $$;

create or replace function public.save_receiving_account(p_ctx_rev integer, p jsonb, p_id uuid default null,
                                                         p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if p_id is null then
    insert into app.receiving_accounts (school_id, label, kind, bank_name, account_last4, ifsc, upi_id)
    values (c.school_id, p->>'label', p->>'kind', p->>'bank_name', p->>'account_last4', p->>'ifsc', p->>'upi_id')
    returning id, version into v_id, v;
  else
    update app.receiving_accounts set label = coalesce(p->>'label', label), status = coalesce(p->>'status', status),
           bank_name = coalesce(p->>'bank_name', bank_name), upi_id = coalesce(p->>'upi_id', upi_id)
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Receiving account');
  end if;
  return jsonb_build_object('receiving_account_id', v_id, 'version', v);
end $$;

create or replace function public.save_fee_term(p_ctx_rev integer, p_academic_year_id uuid, p_name text, p_sort_order integer,
                                                p_due_date date, p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if p_id is null then
    insert into app.fee_terms (school_id, academic_year_id, name, sort_order, due_date)
    values (c.school_id, p_academic_year_id, p_name, p_sort_order, p_due_date) returning id, version into v_id, v;
  else
    update app.fee_terms set name = p_name, sort_order = p_sort_order, due_date = p_due_date
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Fee term');
  end if;
  return jsonb_build_object('fee_term_id', v_id, 'version', v);
end $$;

-- Price list for one class + term. p_lines: [{fee_head_id, amount_paise}]. Heads left out are
-- retired for that class/term (= "no price"), never silently zero. Issued invoices are unaffected.
create or replace function public.save_fee_structure(p_ctx_rev integer, p_fee_term_id uuid, p_class_id uuid, p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_year uuid; x jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  select academic_year_id into v_year from app.fee_terms where id = p_fee_term_id and school_id = c.school_id;
  if v_year is null then perform private.fail('NOT_FOUND', 'Fee term not found'); end if;
  update app.fee_structure_lines set status = 'retired'
   where fee_term_id = p_fee_term_id and class_id = p_class_id and status = 'active'
     and fee_head_id not in (select (y->>'fee_head_id')::uuid from jsonb_array_elements(p_lines) y);
  for x in select * from jsonb_array_elements(p_lines) loop
    update app.fee_structure_lines set amount_paise = (x->>'amount_paise')::bigint
     where fee_term_id = p_fee_term_id and class_id = p_class_id and fee_head_id = (x->>'fee_head_id')::uuid and status = 'active';
    if not found then
      insert into app.fee_structure_lines (school_id, academic_year_id, fee_term_id, class_id, fee_head_id, amount_paise, created_by)
      values (c.school_id, v_year, p_fee_term_id, p_class_id, (x->>'fee_head_id')::uuid, (x->>'amount_paise')::bigint, auth.uid());
    end if;
  end loop;
  return jsonb_build_object('fee_term_id', p_fee_term_id, 'class_id', p_class_id, 'lines', jsonb_array_length(p_lines));
end $$;

create or replace function public.save_concession_preset(p_ctx_rev integer, p_name text, p_kind text, p_fee_head_ids uuid[],
                                                         p_percent_bp integer default null, p_fixed_paise bigint default null,
                                                         p_status text default 'active', p_id uuid default null,
                                                         p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if coalesce(array_length(p_fee_head_ids, 1), 0) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Choose the fee heads this concession applies to');
  end if;
  if p_id is null then
    insert into app.concession_presets (school_id, name, kind, percent_bp, fixed_paise, status)
    values (c.school_id, p_name, p_kind, p_percent_bp, p_fixed_paise, p_status) returning id, version into v_id, v;
  else
    update app.concession_presets set name = p_name, kind = p_kind, percent_bp = p_percent_bp, fixed_paise = p_fixed_paise,
           status = p_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Concession preset');
    delete from app.concession_preset_heads where preset_id = v_id;
  end if;
  insert into app.concession_preset_heads (school_id, preset_id, fee_head_id)
  select c.school_id, v_id, h from unnest(p_fee_head_ids) h;
  return jsonb_build_object('concession_preset_id', v_id, 'version', v,
                            'note', 'Applies to invoices issued from now on; issued invoices change only via adjustments');
end $$;

create or replace function public.grant_concession(p_ctx_rev integer, p_student_id uuid, p_academic_year_id uuid,
                                                   p_preset_id uuid, p_reason text, p_fee_term_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  insert into app.student_concessions (school_id, student_id, academic_year_id, preset_id, fee_term_id, reason, granted_by)
  values (c.school_id, p_student_id, p_academic_year_id, p_preset_id, p_fee_term_id, p_reason, auth.uid())
  returning id into v_id;
  return jsonb_build_object('student_concession_id', v_id);
end $$;

create or replace function public.revoke_concession(p_ctx_rev integer, p_student_concession_id uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  update app.student_concessions set status = 'revoked', revoked_by = auth.uid(), revoked_at = now(), revoke_reason = p_reason
   where id = p_student_concession_id and school_id = c.school_id and status = 'active' returning id into v_id;
  perform private.check_updated(v_id is not null, 'Concession');
  return jsonb_build_object('student_concession_id', v_id, 'status', 'revoked');
end $$;

create or replace function public.save_late_fee_rule(p_ctx_rev integer, p_academic_year_id uuid, p_fee_head_id uuid,
                                                     p_amount_paise bigint, p_grace_days integer default 0)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if not exists (select 1 from app.fee_heads where id = p_fee_head_id and school_id = c.school_id and kind = 'late_fee') then
    perform private.fail('VALIDATION_ERROR', 'Choose a fee head of kind "late fee"');
  end if;
  update app.late_fee_rules set status = 'retired' where academic_year_id = p_academic_year_id and status = 'active';
  insert into app.late_fee_rules (school_id, academic_year_id, fee_head_id, amount_paise, grace_days, created_by)
  values (c.school_id, p_academic_year_id, p_fee_head_id, p_amount_paise, p_grace_days, auth.uid()) returning id into v_id;
  return jsonb_build_object('late_fee_rule_id', v_id);
end $$;

create or replace function public.set_optional_fee(p_ctx_rev integer, p_student_id uuid, p_academic_year_id uuid,
                                                   p_fee_head_id uuid, p_enabled boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  if p_enabled then
    insert into app.student_optional_fees (school_id, student_id, academic_year_id, fee_head_id, created_by)
    select c.school_id, p_student_id, p_academic_year_id, p_fee_head_id, auth.uid()
     where not exists (select 1 from app.student_optional_fees where student_id = p_student_id
                         and academic_year_id = p_academic_year_id and fee_head_id = p_fee_head_id and status = 'active');
  else
    update app.student_optional_fees set status = 'removed'
     where student_id = p_student_id and academic_year_id = p_academic_year_id and fee_head_id = p_fee_head_id
       and status = 'active' and school_id = c.school_id;
  end if;
  return jsonb_build_object('enabled', p_enabled);
end $$;

-- Excess/unidentified money: recorded as an exception, never credited (PRD FEE-04, AC-25)
create or replace function public.record_payment_exception(p_ctx_rev integer, p_kind text, p_amount_paise bigint, p_note text,
                                                           p_student_id uuid default null, p_collection_id uuid default null,
                                                           p_reference text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('fees.manage');
  insert into app.payment_exceptions (school_id, student_id, kind, amount_paise, collection_id, reference, note, created_by)
  values (c.school_id, p_student_id, p_kind, p_amount_paise, p_collection_id, p_reference, p_note, auth.uid())
  returning id into v_id;
  return jsonb_build_object('payment_exception_id', v_id);
end $$;

-- =============================================================================
-- Students & guardians (edits after admission)
-- =============================================================================
create or replace function public.update_student(p_ctx_rev integer, p_student_id uuid, p jsonb, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('students.manage');
  update app.students set
    full_name = coalesce(p->>'full_name', full_name), gender = coalesce(p->>'gender', gender),
    date_of_birth = coalesce((p->>'date_of_birth')::date, date_of_birth),
    mother_name = case when p ? 'mother_name' then p->>'mother_name' else mother_name end,
    father_name = case when p ? 'father_name' then p->>'father_name' else father_name end,
    guardian_name = case when p ? 'guardian_name' then p->>'guardian_name' else guardian_name end,
    address_line = case when p ? 'address_line' then p->>'address_line' else address_line end,
    pincode = case when p ? 'pincode' then p->>'pincode' else pincode end,
    mobile = case when p ? 'mobile' then p->>'mobile' else mobile end,
    alt_mobile = case when p ? 'alt_mobile' then p->>'alt_mobile' else alt_mobile end,
    email = case when p ? 'email' then p->>'email' else email end,
    mother_tongue = case when p ? 'mother_tongue' then p->>'mother_tongue' else mother_tongue end,
    is_indian_national = coalesce((p->>'is_indian_national')::boolean, is_indian_national),
    nationality = case when p ? 'nationality' then p->>'nationality' else nationality end,
    blood_group = case when p ? 'blood_group' then p->>'blood_group' else blood_group end,
    previous_school = case when p ? 'previous_school' then p->>'previous_school' else previous_school end,
    previous_class = case when p ? 'previous_class' then p->>'previous_class' else previous_class end,
    status = coalesce(p->>'status', status),
    updated_by = auth.uid()
  where id = p_student_id and school_id = c.school_id and version = p_expected_version returning version into v;
  perform private.check_updated(v is not null, 'Student record');
  return jsonb_build_object('student_id', p_student_id, 'version', v);
end $$;

create or replace function public.save_student_sensitive(p_ctx_rev integer, p_student_id uuid, p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; r app.student_sensitive;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('students.sensitive');
  r := jsonb_populate_record(null::app.student_sensitive, p);
  insert into app.student_sensitive (student_id, school_id, name_as_per_aadhaar, aadhaar_number, student_national_code,
    apaar_id, social_category, minority_group, is_bpl, is_aay, is_ews_disadvantaged, is_cwsn, impairment_type,
    has_disability_cert, disability_percent, is_out_of_school_child, mainstreamed_in, family_annual_income_paise, updated_by)
  values (p_student_id, c.school_id, r.name_as_per_aadhaar, r.aadhaar_number, r.student_national_code, r.apaar_id,
    r.social_category, r.minority_group, r.is_bpl, r.is_aay, r.is_ews_disadvantaged, r.is_cwsn, r.impairment_type,
    r.has_disability_cert, r.disability_percent, r.is_out_of_school_child, r.mainstreamed_in, r.family_annual_income_paise, auth.uid())
  on conflict (student_id) do update set
    name_as_per_aadhaar = excluded.name_as_per_aadhaar, aadhaar_number = excluded.aadhaar_number,
    student_national_code = excluded.student_national_code, apaar_id = excluded.apaar_id,
    social_category = excluded.social_category, minority_group = excluded.minority_group, is_bpl = excluded.is_bpl,
    is_aay = excluded.is_aay, is_ews_disadvantaged = excluded.is_ews_disadvantaged, is_cwsn = excluded.is_cwsn,
    impairment_type = excluded.impairment_type, has_disability_cert = excluded.has_disability_cert,
    disability_percent = excluded.disability_percent, is_out_of_school_child = excluded.is_out_of_school_child,
    mainstreamed_in = excluded.mainstreamed_in, family_annual_income_paise = excluded.family_annual_income_paise,
    updated_by = excluded.updated_by;
  return jsonb_build_object('student_id', p_student_id);
end $$;

-- Create/update a guardian and (optionally) link to a student. Never merges by phone.
create or replace function public.save_guardian(p_ctx_rev integer, p jsonb, p_guardian_id uuid default null,
                                                p_expected_version integer default null, p_link_student_id uuid default null,
                                                p_relationship text default null, p_is_primary boolean default false,
                                                p_portal_access boolean default true)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c record; v_id uuid; v integer;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('students.manage');
  if p_guardian_id is null then
    insert into app.guardians (school_id, full_name, phone, alt_phone, email, occupation, address_line, created_by)
    values (c.school_id, p->>'full_name', p->>'phone', p->>'alt_phone', p->>'email', p->>'occupation', p->>'address_line', auth.uid())
    returning id, version into v_id, v;
  elsif p <> '{}'::jsonb then
    update app.guardians set full_name = coalesce(p->>'full_name', full_name),
      phone = case when p ? 'phone' then p->>'phone' else phone end,
      alt_phone = case when p ? 'alt_phone' then p->>'alt_phone' else alt_phone end,
      email = case when p ? 'email' then p->>'email' else email end,
      occupation = case when p ? 'occupation' then p->>'occupation' else occupation end,
      address_line = case when p ? 'address_line' then p->>'address_line' else address_line end,
      status = coalesce(p->>'status', status)
    where id = p_guardian_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Guardian');
  else
    v_id := p_guardian_id;
  end if;
  if p_link_student_id is not null then
    if p_is_primary then
      update app.student_guardians set is_primary = false where student_id = p_link_student_id and is_primary;
    end if;
    insert into app.student_guardians (school_id, student_id, guardian_id, relationship, is_primary, portal_access)
    values (c.school_id, p_link_student_id, v_id, coalesce(p_relationship, 'guardian'), p_is_primary, p_portal_access)
    on conflict (student_id, guardian_id) do update
      set relationship = excluded.relationship, is_primary = excluded.is_primary, portal_access = excluded.portal_access;
  end if;
  return jsonb_build_object('guardian_id', v_id, 'version', v,
    'same_phone_guardians', coalesce((select jsonb_agg(jsonb_build_object('guardian_id', g.id, 'full_name', g.full_name))
                                      from app.guardians g where g.school_id = c.school_id and g.id <> v_id
                                        and g.phone = (select phone from app.guardians where id = v_id)), '[]'));
end $$;

-- =============================================================================
-- Reads (role-shaped projections; sensitive fields only with the right capability)
-- =============================================================================
create or replace function public.get_setup_snapshot(p_ctx_rev integer, p_academic_year_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_year uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  v_year := coalesce(p_academic_year_id, (select id from app.academic_years where school_id = c.school_id and is_current));
  return jsonb_build_object(
    'academic_years', (select coalesce(jsonb_agg(to_jsonb(y) - 'school_id' order by y.start_date desc), '[]') from app.academic_years y where y.school_id = c.school_id),
    'selected_year_id', v_year,
    'classes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'sort_order', sort_order, 'status', status, 'version', version) order by sort_order), '[]')
                  from app.classes where school_id = c.school_id),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'class_id', s.class_id, 'name', s.name, 'status', s.status, 'version', s.version)
                   order by s.sort_order, s.name), '[]') from app.sections s where s.school_id = c.school_id and s.academic_year_id = v_year),
    'subjects', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'status', status, 'version', version) order by name), '[]')
                   from app.subjects where school_id = c.school_id),
    'period_schedules', (select coalesce(jsonb_agg(jsonb_build_object('id', ps.id, 'name', ps.name, 'kind', ps.kind,
                            'effective_from', ps.effective_from, 'effective_to', ps.effective_to,
                            'slots', (select jsonb_agg(jsonb_build_object('ordinal', ordinal, 'label', label, 'kind', kind,
                                                       'start_time', start_time, 'end_time', end_time) order by ordinal)
                                        from app.schedule_slots where period_schedule_id = ps.id))
                          order by ps.effective_from desc), '[]') from app.period_schedules ps where ps.school_id = c.school_id and ps.status = 'active'),
    'attendance_mode_today', private.attendance_mode_on(c.school_id, private.school_today(c.school_id)));
end $$;
grant execute on function private.attendance_mode_on(uuid, date) to authenticated;

-- Directory search: keyset pagination on (name, id). Teachers see only their scope (RLS).
create or replace function public.list_students(p_ctx_rev integer, p_search text default null, p_section_id uuid default null,
                                                p_class_id uuid default null, p_after_name text default null,
                                                p_after_id uuid default null, p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_today date; v_items jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  if not (private.has_cap('students.read_all') or c.role = 'teacher') then perform private.fail('FORBIDDEN', 'Not permitted'); end if;
  v_today := private.school_today(c.school_id);
  select coalesce(jsonb_agg(x), '[]') into v_items from (
    select jsonb_build_object('student_id', s.id, 'name', s.full_name, 'admission_no', s.admission_no, 'status', s.status,
                              'class', cl.name, 'section', sec.name, 'section_id', sec.id, 'roll_no', p.roll_no) as x
      from app.students s
      left join app.placements p on p.student_id = s.id and p.effective_from <= v_today
                                and (p.effective_to is null or p.effective_to > v_today)
      left join app.sections sec on sec.id = p.section_id
      left join app.classes cl on cl.id = sec.class_id
     where s.school_id = c.school_id
       and (p_search is null or lower(s.full_name) like lower(p_search) || '%' or upper(s.admission_no) = upper(p_search)
            or lower(s.full_name) like '% ' || lower(p_search) || '%')
       and (p_section_id is null or sec.id = p_section_id)
       and (p_class_id is null or cl.id = p_class_id)
       and (p_after_name is null or (lower(s.full_name), s.id) > (lower(p_after_name), p_after_id))
     order by lower(s.full_name), s.id
     limit least(coalesce(p_limit, 50), 100)) q;
  return jsonb_build_object('items', v_items,
    'next_cursor', case when jsonb_array_length(v_items) = least(coalesce(p_limit, 50), 100)
                        then jsonb_build_object('after_name', v_items->-1->>'name', 'after_id', v_items->-1->>'student_id') end);
end $$;

-- Profile with role-appropriate tabs. Sensitive block only for students.sensitive.
create or replace function public.get_student_profile(p_ctx_rev integer, p_student_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record; v_s jsonb;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  select to_jsonb(s) - 'school_id' - 'account_id' - 'created_by' - 'updated_by' into v_s
    from app.students s where s.id = p_student_id and s.school_id = c.school_id;     -- RLS limits the row
  if v_s is null then perform private.fail('NOT_FOUND', 'Student not found'); end if;
  return jsonb_build_object(
    'profile', v_s,
    'age_today', extract(year from age(private.school_today(c.school_id), (v_s->>'date_of_birth')::date)),
    'guardians', (select coalesce(jsonb_agg(jsonb_build_object('guardian_id', g.id, 'name', g.full_name, 'phone', g.phone,
                     'email', g.email, 'occupation', g.occupation, 'relationship', sg.relationship,
                     'is_primary', sg.is_primary, 'portal_access', sg.portal_access, 'has_login', g.account_id is not null)), '[]')
                    from app.student_guardians sg join app.guardians g on g.id = sg.guardian_id where sg.student_id = p_student_id),
    'placements', (select coalesce(jsonb_agg(jsonb_build_object('section_id', p.section_id, 'class', cl.name, 'section', sec.name,
                      'roll_no', p.roll_no, 'from', p.effective_from, 'to', p.effective_to, 'reason', p.reason,
                      'year', ay.name) order by p.effective_from desc), '[]')
                     from app.placements p join app.sections sec on sec.id = p.section_id
                     join app.classes cl on cl.id = sec.class_id join app.academic_years ay on ay.id = p.academic_year_id
                    where p.student_id = p_student_id),
    'sensitive', case when private.has_cap('students.sensitive')
                      then (select to_jsonb(ss) - 'school_id' - 'student_id' from app.student_sensitive ss where ss.student_id = p_student_id) end,
    'can', jsonb_build_object('edit', private.has_cap('students.manage'), 'fees', private.has_cap('fees.read'),
                              'attendance', private.has_cap('attendance.read_all') or c.role in ('teacher','parent','student')));
end $$;

create or replace function public.list_staff(p_ctx_rev integer, p_staff_group_id uuid default null, p_include_inactive boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff.read');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'staff_id', s.id, 'employee_no', s.employee_no, 'name', s.full_name, 'group', g.name, 'staff_group_id', g.id,
      'designation', s.designation, 'is_teaching', s.is_teaching, 'phone', s.phone, 'status', s.status,
      'joined_on', s.joined_on, 'has_login', s.account_id is not null, 'version', s.version) order by s.full_name)
    from app.staff s join app.staff_groups g on g.id = s.staff_group_id
   where s.school_id = c.school_id and (p_staff_group_id is null or s.staff_group_id = p_staff_group_id)
     and (p_include_inactive or s.status = 'active')), '[]');
end $$;

create or replace function public.list_leads(p_ctx_rev integer, p_stage text default null, p_search text default null,
                                             p_before_created_at timestamptz default null, p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('admissions.manage');
  return coalesce((select jsonb_agg(to_jsonb(l) - 'school_id' order by l.created_at desc) from (
    select * from app.leads
     where school_id = c.school_id and (p_stage is null or stage = p_stage)
       and (p_search is null or phone = p_search or lower(parent_name) like lower(p_search) || '%'
            or lower(coalesce(child_name, '')) like lower(p_search) || '%')
       and (p_before_created_at is null or created_at < p_before_created_at)
     order by created_at desc limit least(coalesce(p_limit, 50), 100)) l), '[]');
end $$;

-- Teacher "today": own lessons (incl. substitutions), marking status, diary/homework gaps
create or replace function public.get_teacher_today(p_ctx_rev integer, p_date date default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
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
        'has_diary', exists (select 1 from app.diary_entries d where d.lesson_session_id = ls.id),
        'homework_count', (select count(*) from app.homework_assignments h where h.lesson_session_id = ls.id and h.status = 'active'))
        order by ls.start_time)
      from app.lesson_sessions ls join app.sections sec on sec.id = ls.section_id join app.classes cl on cl.id = sec.class_id
      join app.subjects sub on sub.id = ls.subject_id
     where ls.school_id = c.school_id and ls.session_date = v_date and ls.actual_staff_id = c.staff_id), '[]'),
    'class_teacher_sections', coalesce((select jsonb_agg(jsonb_build_object('section_id', ta.section_id,
        'section', cl.name || ' ' || sec.name,
        'daily_marked', (select count(*) from app.student_daily_attendance d where d.section_id = ta.section_id and d.attendance_date = v_date)))
      from app.teaching_assignments ta join app.sections sec on sec.id = ta.section_id join app.classes cl on cl.id = sec.class_id
     where ta.staff_id = c.staff_id and ta.kind = 'class_teacher' and ta.effective_from <= v_date
       and (ta.effective_to is null or ta.effective_to > v_date)), '[]'),
    'homework_to_check', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', h.id, 'section_id', h.section_id,
        'due_on', h.due_on, 'checked', (select count(*) from app.homework_checks hc where hc.assignment_id = h.id)))
      from app.homework_assignments h
     where h.school_id = c.school_id and h.status = 'active' and h.assigned_by_staff = c.staff_id
       and h.due_on between v_date - 14 and v_date), '[]'));
end $$;

grant execute on function
  public.save_school_profile(integer, jsonb, integer), public.save_academic_year(integer, text, date, date, uuid, integer),
  public.set_current_year(integer, uuid), public.save_class(integer, text, integer, text, uuid, integer),
  public.save_section(integer, uuid, uuid, text, integer, integer, text, uuid, integer),
  public.save_subject(integer, text, text, text, uuid, integer), public.save_class_subjects(integer, uuid, uuid, jsonb),
  public.save_period_schedule(integer, text, text, time, time, date, jsonb),
  public.save_calendar_range(integer, uuid, text, date, date, text, uuid, uuid, text, text, boolean, integer[]),
  public.save_calendar_pattern(integer, uuid, text, jsonb, uuid), public.set_attendance_mode(integer, text, date),
  public.save_staff_group(integer, text, text, bigint, uuid, integer), public.save_staff(integer, jsonb, uuid, integer),
  public.save_staff_finance(integer, uuid, bigint, date, text, jsonb), public.get_staff_confidential(integer, uuid),
  public.record_paid_leave(integer, uuid, date, numeric, text), public.cancel_paid_leave(integer, uuid),
  public.save_teaching_assignment(integer, uuid, uuid, text, date, uuid), public.end_teaching_assignment(integer, uuid, date),
  public.save_timetable_draft(integer, uuid, uuid, date, jsonb, uuid), public.activate_timetable(integer, uuid),
  public.copy_timetable(integer, uuid, uuid, date, boolean),
  public.save_fee_head(integer, text, text, text, boolean, text, uuid, integer),
  public.save_receiving_account(integer, jsonb, uuid, integer),
  public.save_fee_term(integer, uuid, text, integer, date, uuid, integer),
  public.save_fee_structure(integer, uuid, uuid, jsonb),
  public.save_concession_preset(integer, text, text, uuid[], integer, bigint, text, uuid, integer),
  public.grant_concession(integer, uuid, uuid, uuid, text, uuid), public.revoke_concession(integer, uuid, text),
  public.save_late_fee_rule(integer, uuid, uuid, bigint, integer), public.set_optional_fee(integer, uuid, uuid, uuid, boolean),
  public.record_payment_exception(integer, text, bigint, text, uuid, uuid, text),
  public.update_student(integer, uuid, jsonb, integer), public.save_student_sensitive(integer, uuid, jsonb),
  public.save_guardian(integer, jsonb, uuid, integer, uuid, text, boolean, boolean),
  public.get_setup_snapshot(integer, uuid), public.list_students(integer, text, uuid, uuid, text, uuid, integer),
  public.get_student_profile(integer, uuid), public.list_staff(integer, uuid, boolean),
  public.list_leads(integer, text, text, timestamptz, integer), public.get_teacher_today(integer, date)
to authenticated;
