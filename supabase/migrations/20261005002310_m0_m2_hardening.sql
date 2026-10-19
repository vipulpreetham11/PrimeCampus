-- =============================================================================
-- PrimeCampus V1 — 2310 M0–M2 hardening (before M3)
--  * readable errors: the 24 older setup/people/timetable RPCs written as invoker functions in 1300
--    now turn database rule violations into hinted errors (DUPLICATE / VALIDATION_ERROR / CONFLICT /
--    FORBIDDEN) with a plain message and {field, constraint} details, instead of raw SQL errors
--  * save_staff_group: p_clear_default_salary clears the group's default salary
--  * activate_timetable: optional p_expected_version (CONFLICT when the draft changed)
--  * copy_timetable / save_timetable_draft (new draft): start date must be inside the target
--    section's year; a second draft for the same section and start date is refused as DUPLICATE
--    with the existing draft's id (a retry after a lost reply can never make two drafts)
--  * save_homework (create): the same lesson + same text again is refused as DUPLICATE with the
--    existing homework's id (a retry after a lost reply can never make two)
--  * get_homework_roster: can_check flag;  get_teacher_today.homework_to_check: subject, section,
--    eligible count
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Readable database errors
-- -----------------------------------------------------------------------------
create table if not exists private.db_error_messages (
  constraint_name text primary key,
  code            text not null check (code in ('DUPLICATE','VALIDATION_ERROR','CONFLICT')),
  field           text,
  message         text not null
);
revoke all on private.db_error_messages from public, anon, authenticated;

insert into private.db_error_messages (constraint_name, code, field, message) values
  ('academic_years_school_id_name_key', 'DUPLICATE', 'name', 'Another academic year already has this name'),
  ('academic_years_no_overlap', 'VALIDATION_ERROR', 'start_date', 'These dates overlap another academic year'),
  ('academic_years_check', 'VALIDATION_ERROR', 'end_date', 'End date must be after the start date'),
  ('academic_years_check1', 'VALIDATION_ERROR', 'end_date', 'An academic year can be at most 550 days long'),
  ('academic_years_name_check', 'VALIDATION_ERROR', 'name', 'Name is required (up to 40 characters)'),
  ('academic_years_one_current', 'CONFLICT', null, 'Another year was made current at the same time. Reload and try again.'),
  ('attendance_modes_school_id_effective_from_key', 'DUPLICATE', 'effective_from', 'A mode change already starts on this date'),
  ('attendance_modes_mode_check', 'VALIDATION_ERROR', 'mode', 'Mode must be day-wise or period-wise'),
  ('calendar_days_check', 'VALIDATION_ERROR', 'staff_group_id', 'Staff groups apply only to the staff calendar'),
  ('calendar_days_check1', 'VALIDATION_ERROR', 'period_schedule_id', 'A student half day needs a bell schedule'),
  ('calendar_days_day_type_check', 'VALIDATION_ERROR', 'day_type', 'Day type must be working, half day, holiday or weekly off'),
  ('calendar_days_audience_check', 'VALIDATION_ERROR', 'audience', 'Calendar must be student or staff'),
  ('calendar_days_label_check', 'VALIDATION_ERROR', 'label', 'Label can be at most 120 characters'),
  ('calendar_days_reason_check', 'VALIDATION_ERROR', 'reason', 'Reason can be at most 500 characters'),
  ('calendar_patterns_check', 'VALIDATION_ERROR', 'staff_group_id', 'Staff groups apply only to the staff calendar'),
  ('calendar_patterns_check1', 'VALIDATION_ERROR', 'period_schedule_id', 'A student half day needs a bell schedule'),
  ('calendar_patterns_day_type_check', 'VALIDATION_ERROR', 'day_type', 'Day type must be working, half day or weekly off'),
  ('calendar_patterns_weekday_check', 'VALIDATION_ERROR', 'weekday', 'Weekday must be 1 (Monday) to 7 (Sunday)'),
  ('calendar_patterns_audience_check', 'VALIDATION_ERROR', 'audience', 'Calendar must be student or staff'),
  ('class_subjects_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or retired'),
  ('classes_name_uq', 'DUPLICATE', 'name', 'A class with this name already exists'),
  ('classes_name_check', 'VALIDATION_ERROR', 'name', 'Class name is required (up to 40 characters)'),
  ('classes_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or retired'),
  ('guardians_phone_check', 'VALIDATION_ERROR', 'phone', 'Mobile number must be 10 digits'),
  ('guardians_alt_phone_check', 'VALIDATION_ERROR', 'alt_phone', 'Alternate mobile number must be 10 digits'),
  ('guardians_email_check', 'VALIDATION_ERROR', 'email', 'Email address is not valid'),
  ('guardians_full_name_check', 'VALIDATION_ERROR', 'full_name', 'Name is required (up to 200 characters)'),
  ('guardians_address_line_check', 'VALIDATION_ERROR', 'address_line', 'Address can be at most 500 characters'),
  ('guardians_occupation_check', 'VALIDATION_ERROR', 'occupation', 'Occupation can be at most 100 characters'),
  ('guardians_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or inactive'),
  ('period_schedules_check', 'VALIDATION_ERROR', 'day_end', 'The school day must end after it starts'),
  ('period_schedules_check1', 'VALIDATION_ERROR', 'effective_from', 'End date must be after the start date'),
  ('period_schedules_kind_check', 'VALIDATION_ERROR', 'kind', 'Kind must be regular, half day or special'),
  ('period_schedules_name_check', 'VALIDATION_ERROR', 'name', 'Name is required (up to 60 characters)'),
  ('period_schedules_regular_no_overlap', 'VALIDATION_ERROR', 'effective_from', 'Another regular bell schedule already covers these dates'),
  ('schedule_slots_check', 'VALIDATION_ERROR', 'slots', 'Each period or break must end after it starts'),
  ('schedule_slots_kind_check', 'VALIDATION_ERROR', 'slots', 'Each slot must be a period or a break'),
  ('schedule_slots_label_check', 'VALIDATION_ERROR', 'slots', 'Each slot needs a label (up to 40 characters)'),
  ('schedule_slots_no_overlap', 'VALIDATION_ERROR', 'slots', 'Two periods or breaks overlap in time'),
  ('schedule_slots_ordinal_check', 'VALIDATION_ERROR', 'slots', 'Slot numbers must be 1–20'),
  ('schedule_slots_period_schedule_id_ordinal_key', 'VALIDATION_ERROR', 'slots', 'Two slots have the same number'),
  ('schools_udise_code_check', 'VALIDATION_ERROR', 'udise_code', 'UDISE code must be 11 digits'),
  ('schools_phone_check', 'VALIDATION_ERROR', 'phone', 'Phone: 6–20 digits (spaces, + and - allowed)'),
  ('schools_pincode_check', 'VALIDATION_ERROR', 'pincode', 'Pincode must be 6 digits'),
  ('schools_email_check', 'VALIDATION_ERROR', 'email', 'Email address is not valid'),
  ('schools_name_check', 'VALIDATION_ERROR', 'name', 'School name is required (up to 200 characters)'),
  ('sections_name_uq', 'DUPLICATE', 'name', 'This class already has a section with this name in this year'),
  ('sections_name_check', 'VALIDATION_ERROR', 'name', 'Section name is required (up to 20 characters)'),
  ('sections_capacity_check', 'VALIDATION_ERROR', 'capacity', 'Capacity must be 1–200'),
  ('sections_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or retired'),
  ('staff_employee_no_uq', 'DUPLICATE', 'employee_no', 'Another staff member already has this employee number'),
  ('staff_employee_no_check', 'VALIDATION_ERROR', 'employee_no', 'Employee number is required (up to 40 characters)'),
  ('staff_full_name_check', 'VALIDATION_ERROR', 'full_name', 'Name is required (up to 200 characters)'),
  ('staff_check', 'VALIDATION_ERROR', 'left_on', 'Leaving date can''t be before the joining date'),
  ('staff_phone_check', 'VALIDATION_ERROR', 'phone', 'Mobile number must be 10 digits'),
  ('staff_email_check', 'VALIDATION_ERROR', 'email', 'Email address is not valid'),
  ('staff_gender_check', 'VALIDATION_ERROR', 'gender', 'Gender must be male, female or transgender'),
  ('staff_designation_check', 'VALIDATION_ERROR', 'designation', 'Designation can be at most 80 characters'),
  ('staff_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or inactive'),
  ('staff_bank_accounts_account_number_check', 'VALIDATION_ERROR', 'account_number', 'Account number must be 6–20 digits'),
  ('staff_bank_accounts_ifsc_check', 'VALIDATION_ERROR', 'ifsc', 'IFSC must look like SBIN0001234 (11 characters)'),
  ('staff_bank_accounts_account_holder_name_check', 'VALIDATION_ERROR', 'account_holder_name', 'Account holder name is required (up to 200 characters)'),
  ('staff_bank_accounts_bank_name_check', 'VALIDATION_ERROR', 'bank_name', 'Bank name can be at most 120 characters'),
  ('staff_group_salary_defaults_monthly_salary_paise_check', 'VALIDATION_ERROR', 'default_salary', 'Salary must be ₹0 or more'),
  ('staff_groups_name_uq', 'DUPLICATE', 'name', 'Another staff group already has this name'),
  ('staff_groups_name_check', 'VALIDATION_ERROR', 'name', 'Name is required (up to 80 characters)'),
  ('staff_groups_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or retired'),
  ('staff_salary_rates_staff_id_effective_from_key', 'DUPLICATE', 'effective_from', 'A salary already starts on this date for this staff member'),
  ('staff_salary_rates_monthly_salary_paise_check', 'VALIDATION_ERROR', 'monthly_salary', 'Salary must be ₹0 or more'),
  ('staff_salary_rates_reason_check', 'VALIDATION_ERROR', 'reason', 'Reason can be at most 500 characters'),
  ('student_guardians_one_primary', 'CONFLICT', 'is_primary', 'This student already has a primary parent. Reload and try again.'),
  ('student_guardians_relationship_check', 'VALIDATION_ERROR', 'relationship', 'Relationship must be mother, father, guardian, grandparent, sibling or other'),
  ('student_sensitive_aadhaar_number_check', 'VALIDATION_ERROR', 'aadhaar_number', 'Aadhaar number must be 12 digits'),
  ('student_sensitive_aadhaar_uq', 'DUPLICATE', 'aadhaar_number', 'Another student in this school already has this Aadhaar number'),
  ('student_sensitive_check', 'VALIDATION_ERROR', 'impairment_type', 'Impairment details need "Child with special needs" to be ticked'),
  ('student_sensitive_check1', 'VALIDATION_ERROR', 'is_aay', 'AAY needs BPL to be ticked'),
  ('student_sensitive_check2', 'VALIDATION_ERROR', 'mainstreamed_in', '"Mainstreamed in" needs "Out-of-school child" to be ticked'),
  ('student_sensitive_disability_percent_check', 'VALIDATION_ERROR', 'disability_percent', 'Disability percent must be 0–100'),
  ('student_sensitive_family_annual_income_paise_check', 'VALIDATION_ERROR', 'family_annual_income', 'Income can''t be negative'),
  ('student_sensitive_social_category_check', 'VALIDATION_ERROR', 'social_category', 'Social category must be General, SC, ST or OBC'),
  ('student_sensitive_minority_group_check', 'VALIDATION_ERROR', 'minority_group', 'Choose a minority group from the list'),
  ('student_sensitive_mainstreamed_in_check', 'VALIDATION_ERROR', 'mainstreamed_in', 'Choose current year or an earlier year'),
  ('students_admission_no_uq', 'DUPLICATE', 'admission_no', 'Another student already has this admission number'),
  ('students_full_name_check', 'VALIDATION_ERROR', 'full_name', 'Name is required (up to 200 characters)'),
  ('students_mobile_check', 'VALIDATION_ERROR', 'mobile', 'Mobile number must be 10 digits'),
  ('students_alt_mobile_check', 'VALIDATION_ERROR', 'alt_mobile', 'Alternate mobile number must be 10 digits'),
  ('students_pincode_check', 'VALIDATION_ERROR', 'pincode', 'Pincode must be 6 digits'),
  ('students_email_check', 'VALIDATION_ERROR', 'email', 'Email address is not valid'),
  ('students_date_of_birth_check', 'VALIDATION_ERROR', 'date_of_birth', 'Date of birth looks wrong'),
  ('students_check', 'VALIDATION_ERROR', 'nationality', 'Enter the nationality for a student who is not an Indian national'),
  ('students_gender_check', 'VALIDATION_ERROR', 'gender', 'Gender must be male, female or transgender'),
  ('students_blood_group_check', 'VALIDATION_ERROR', 'blood_group', 'Choose a blood group from the list'),
  ('students_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active, inactive or archived'),
  ('subjects_code_uq', 'DUPLICATE', 'code', 'Another subject already uses this code'),
  ('subjects_name_uq', 'DUPLICATE', 'name', 'Another subject already has this name'),
  ('subjects_code_check', 'VALIDATION_ERROR', 'code', 'Subject code: 1–20 letters, digits, - or _'),
  ('subjects_name_check', 'VALIDATION_ERROR', 'name', 'Subject name is required (up to 80 characters)'),
  ('subjects_status_check', 'VALIDATION_ERROR', 'status', 'Status must be active or retired'),
  ('no_duplicate_subject_assignment', 'DUPLICATE', 'subject_id', 'This teacher already teaches this subject in this section on these dates'),
  ('one_class_teacher_per_section', 'VALIDATION_ERROR', 'staff_id', 'This section already has a class teacher on these dates. End that assignment first.'),
  ('teaching_assignments_check', 'VALIDATION_ERROR', 'subject_id', 'A subject assignment needs a subject (a class-teacher assignment must not have one)'),
  ('teaching_assignments_check1', 'VALIDATION_ERROR', 'effective_to', 'End date must be after the start date'),
  ('teaching_assignments_kind_check', 'VALIDATION_ERROR', 'kind', 'Kind must be subject or class teacher'),
  ('timetable_versions_no_overlap', 'CONFLICT', 'effective_from', 'Another active timetable for this section covers these dates'),
  ('staff_paid_leave_one_per_day', 'DUPLICATE', 'leave_date', 'Paid leave is already recorded for this day')
on conflict (constraint_name) do update set code = excluded.code, field = excluded.field, message = excluded.message;

-- Re-raises our own hinted errors unchanged; maps database rule violations to hinted errors.
create or replace function private.raise_db_error(p_state text, p_constraint text, p_table text, p_column text,
                                                  p_message text, p_detail text, p_hint text)
returns void language plpgsql security definer set search_path = '' as $$
declare m private.db_error_messages; v_field text; v_label text;
begin
  if p_state = 'P0001' then
    raise exception using errcode = 'P0001', message = p_message, detail = coalesce(p_detail, ''), hint = coalesce(p_hint, '');
  end if;
  if p_constraint is not null and p_constraint <> '' then
    select * into m from private.db_error_messages where constraint_name = p_constraint;
  end if;
  if m.constraint_name is not null and p_state in ('23505','23514','23P01','23502') then
    perform private.fail(m.code, m.message, jsonb_build_object('field', m.field, 'constraint', p_constraint));
  end if;
  v_field := nullif(coalesce(nullif(p_column, ''),
               nullif(regexp_replace(regexp_replace(coalesce(p_constraint, ''), '^' || coalesce(p_table, '') || '_', ''),
                                     '_(check\d*|key|uq)$', ''), '')), '');
  if v_field ~ '^check\d*$' then v_field := null; end if;
  v_label := initcap(replace(coalesce(v_field, ''), '_', ' '));
  case p_state
    when '23505' then perform private.fail('DUPLICATE', 'This already exists (same name, code or number)',
                                           jsonb_build_object('field', v_field, 'constraint', p_constraint));
    when '23P01' then perform private.fail('CONFLICT', 'This overlaps an existing record on these dates',
                                           jsonb_build_object('field', v_field, 'constraint', p_constraint));
    when '23514' then perform private.fail('VALIDATION_ERROR',
                        case when v_field is null then 'A value is not allowed' else v_label || ' is not valid' end,
                        jsonb_build_object('field', v_field, 'constraint', p_constraint));
    when '23502' then perform private.fail('VALIDATION_ERROR',
                        case when v_field is null then 'A required value is missing' else v_label || ' is required' end,
                        jsonb_build_object('field', v_field));
    when '23503' then perform private.fail('VALIDATION_ERROR', 'Something this refers to doesn''t exist in this school (it may have been removed). Reload and try again.',
                        jsonb_build_object('constraint', p_constraint));
    when '22P02', '22007', '22008', '22003', '22023', '22001', '42804' then
      perform private.fail('VALIDATION_ERROR', 'A value has the wrong format', jsonb_build_object('field', v_field));
    when '42501' then perform private.fail('FORBIDDEN', 'Not permitted');
    when '40001', '40P01', '55P03' then perform private.fail('CONFLICT', 'Someone else was saving at the same time. Reload and try again.');
    else
      raise exception using errcode = p_state, message = p_message, detail = coalesce(p_detail, ''), hint = coalesce(p_hint, '');
  end case;
end $$;
-- -----------------------------------------------------------------------------
-- Older invoker RPCs: same signature and behaviour, readable errors
-- -----------------------------------------------------------------------------
create or replace function public.save_school_profile(p_ctx_rev integer, p jsonb, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_academic_year(p_ctx_rev integer, p_name text, p_start_date date, p_end_date date,
                                                     p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.set_current_year(p_ctx_rev integer, p_academic_year_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if not exists (select 1 from app.academic_years where id = p_academic_year_id and school_id = c.school_id) then
    perform private.fail('NOT_FOUND', 'Academic year not found');
  end if;
  update app.academic_years set is_current = false where school_id = c.school_id and is_current and id <> p_academic_year_id;
  update app.academic_years set is_current = true where id = p_academic_year_id;
  return jsonb_build_object('academic_year_id', p_academic_year_id, 'is_current', true);
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_class(p_ctx_rev integer, p_name text, p_sort_order integer, p_status text default 'active',
                                             p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_section(p_ctx_rev integer, p_academic_year_id uuid, p_class_id uuid, p_name text,
                                               p_capacity integer default null, p_sort_order integer default 0,
                                               p_status text default 'active', p_id uuid default null,
                                               p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_subject(p_ctx_rev integer, p_name text, p_code text, p_status text default 'active',
                                               p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_class_subjects(p_ctx_rev integer, p_academic_year_id uuid, p_class_id uuid, p_subjects jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_period_schedule(p_ctx_rev integer, p_name text, p_kind text, p_day_start time,
                                                       p_day_end time, p_effective_from date, p_slots jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_calendar_pattern(p_ctx_rev integer, p_academic_year_id uuid, p_audience text,
                                                        p_patterns jsonb, p_staff_group_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_calendar_range(p_ctx_rev integer, p_academic_year_id uuid, p_audience text,
                                                      p_from date, p_to date, p_day_type text,
                                                      p_staff_group_id uuid default null, p_period_schedule_id uuid default null,
                                                      p_label text default null, p_reason text default null,
                                                      p_is_exam_day boolean default false, p_weekdays integer[] default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_n integer; v_affected bigint;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.set_attendance_mode(p_ctx_rev integer, p_mode text, p_effective_from date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('setup.manage');
  if p_effective_from < private.school_today(c.school_id) then
    perform private.fail('VALIDATION_ERROR', 'A mode change cannot start in the past (history is never rewritten)');
  end if;
  insert into app.attendance_modes (school_id, mode, effective_from, created_by)
  values (c.school_id, p_mode, p_effective_from, auth.uid());
  return jsonb_build_object('mode', p_mode, 'effective_from', p_effective_from);
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_staff(p_ctx_rev integer, p jsonb, p_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_staff_finance(p_ctx_rev integer, p_staff_id uuid, p_monthly_salary_paise bigint default null,
                                                     p_effective_from date default null, p_reason text default null,
                                                     p_bank jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.get_staff_confidential(p_ctx_rev integer, p_staff_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_teaching_assignment(p_ctx_rev integer, p_section_id uuid, p_staff_id uuid, p_kind text,
                                                           p_effective_from date, p_subject_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  insert into app.teaching_assignments (school_id, academic_year_id, section_id, staff_id, kind, subject_id, effective_from, created_by)
  select c.school_id, s.academic_year_id, s.id, p_staff_id, p_kind, p_subject_id, p_effective_from, auth.uid()
    from app.sections s where s.id = p_section_id and s.school_id = c.school_id
  returning id into v_id;
  if v_id is null then perform private.fail('NOT_FOUND', 'Section not found'); end if;
  return jsonb_build_object('teaching_assignment_id', v_id);
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.end_teaching_assignment(p_ctx_rev integer, p_teaching_assignment_id uuid, p_effective_to date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('timetable.manage');
  update app.teaching_assignments set effective_to = p_effective_to
   where id = p_teaching_assignment_id and school_id = c.school_id and effective_from < p_effective_to
     and (effective_to is null or effective_to > p_effective_to)
  returning id into v_id;
  perform private.check_updated(v_id is not null, 'Teaching assignment');
  return jsonb_build_object('teaching_assignment_id', v_id, 'effective_to', p_effective_to);
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_guardian(p_ctx_rev integer, p jsonb, p_guardian_id uuid default null,
                                                p_expected_version integer default null, p_link_student_id uuid default null,
                                                p_relationship text default null, p_is_primary boolean default false,
                                                p_portal_access boolean default true)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.update_student(p_ctx_rev integer, p_student_id uuid, p jsonb, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v integer;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.save_student_sensitive(p_ctx_rev integer, p_student_id uuid, p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; r app.student_sensitive;
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
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

create or replace function public.cancel_paid_leave(p_ctx_rev integer, p_paid_leave_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
        c record; v_id uuid;
begin
  select * into c from private.require_ctx(p_ctx_rev);
  perform private.require_cap('staff_finance.manage');
  update app.staff_paid_leave set status = 'cancelled' where id = p_paid_leave_id and school_id = c.school_id and status = 'active'
  returning id into v_id;
  perform private.check_updated(v_id is not null, 'Paid leave');
  return jsonb_build_object('paid_leave_id', v_id, 'status', 'cancelled');
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

-- -----------------------------------------------------------------------------
-- Staff group: default salary can be cleared
-- -----------------------------------------------------------------------------
drop function if exists public.save_staff_group(integer, text, text, bigint, uuid, integer);
create or replace function private.save_staff_group(p_rev integer, p_name text, p_status text, p_default_salary_paise bigint,
                                                    p_id uuid, p_expected_version integer, p_clear_default_salary boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v integer; v_name text := btrim(coalesce(p_name, '')); v_status text := coalesce(p_status, 'active');
        v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('setup.manage');
  if length(v_name) not between 1 and 80 then perform private.fail('VALIDATION_ERROR', 'Name is required (up to 80 characters)'); end if;
  if v_status not in ('active','retired') then perform private.fail('VALIDATION_ERROR', 'Status must be active or retired'); end if;
  if coalesce(p_clear_default_salary, false) and p_default_salary_paise is not null then
    perform private.fail('VALIDATION_ERROR', 'Either set a default salary or clear it, not both');
  end if;
  if p_default_salary_paise is not null and p_default_salary_paise not between 0 and 100000000000 then
    perform private.fail('VALIDATION_ERROR', 'Salary must be ₹0 or more');
  end if;
  if (p_default_salary_paise is not null or coalesce(p_clear_default_salary, false)) then
    perform private.require_cap('staff_finance.manage');
  end if;
  if p_id is null then
    insert into app.staff_groups (school_id, name, status) values (c.school_id, v_name, v_status) returning id, version into v_id, v;
  else
    if p_expected_version is null then perform private.fail('VALIDATION_ERROR', 'expected version is required'); end if;
    update app.staff_groups set name = v_name, status = v_status
     where id = p_id and school_id = c.school_id and version = p_expected_version returning id, version into v_id, v;
    perform private.check_updated(v_id is not null, 'Staff group');
  end if;
  if p_default_salary_paise is not null then
    insert into app.staff_group_salary_defaults (staff_group_id, school_id, monthly_salary_paise, updated_by)
    values (v_id, c.school_id, p_default_salary_paise, c.account_id)
    on conflict (staff_group_id) do update set monthly_salary_paise = excluded.monthly_salary_paise,
                                               updated_by = excluded.updated_by, updated_at = now();
  elsif coalesce(p_clear_default_salary, false) then
    delete from app.staff_group_salary_defaults where staff_group_id = v_id and school_id = c.school_id;
  end if;
  return jsonb_build_object('staff_group_id', v_id, 'version', v,
    'default_salary_paise', (select monthly_salary_paise from app.staff_group_salary_defaults where staff_group_id = v_id));
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

-- -----------------------------------------------------------------------------
-- Timetable: version-checked activation; copy refuses a second draft and out-of-year dates
-- -----------------------------------------------------------------------------
drop function if exists public.activate_timetable(integer, uuid);
create or replace function private.activate_timetable(p_rev integer, p_version_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v app.timetable_versions; v_conf jsonb;
        v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v from app.timetable_versions where id = p_version_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Timetable not found'); end if;
  if v.status = 'active' then
    return jsonb_build_object('timetable_version_id', v.id, 'status', 'active', 'replayed', true);
  end if;
  if v.status <> 'draft' then perform private.fail('VALIDATION_ERROR', 'Only a draft can be activated'); end if;
  if p_expected_version is not null and p_expected_version <> v.version then
    perform private.fail('CONFLICT', 'This draft changed since you opened it');
  end if;
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
  perform private.log_event('timetable.activated', 'timetable_versions', v.id::text,
    jsonb_build_object('section_id', v.section_id, 'effective_from', v.effective_from), null, v.academic_year_id);
  return jsonb_build_object('timetable_version_id', v.id, 'status', 'active',
                            'next_step', 'Generate lesson sessions for upcoming dates');
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

-- One draft per section and start date (lock the section so two saves can't both pass the check)
create or replace function private.tt_existing_draft(p_school uuid, p_section uuid, p_effective_from date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform 1 from app.sections where id = p_section and school_id = p_school for update;
  select id into v_id from app.timetable_versions
   where school_id = p_school and section_id = p_section and status = 'draft' and effective_from = p_effective_from
   order by created_at limit 1;
  return v_id;
end $$;

create or replace function private.copy_timetable(p_rev integer, p_from_version_id uuid, p_target_section_id uuid,
                                                  p_effective_from date, p_keep_teachers boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_src app.timetable_versions; v_sec record; v_id uuid; v_dup uuid;
        v_es text; v_ec text; v_et text; v_eo text; v_em text; v_ed text; v_eh text;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('timetable.manage');
  select * into v_src from app.timetable_versions where id = p_from_version_id and school_id = c.school_id;
  if not found then perform private.fail('NOT_FOUND', 'Source timetable not found'); end if;
  select s.id, s.academic_year_id, ay.start_date, ay.end_date, ay.name into v_sec
    from app.sections s join app.academic_years ay on ay.id = s.academic_year_id
   where s.id = p_target_section_id and s.school_id = c.school_id;
  if v_sec.id is null then perform private.fail('NOT_FOUND', 'Target section not found'); end if;
  if p_effective_from is null or p_effective_from not between v_sec.start_date and v_sec.end_date then
    perform private.fail('VALIDATION_ERROR', 'Start date must be inside ' || v_sec.name || ', the target section''s year');
  end if;
  v_dup := private.tt_existing_draft(c.school_id, v_sec.id, p_effective_from);
  if v_dup is not null then
    perform private.fail('DUPLICATE', 'This section already has a draft starting on this date. Open it instead.',
                         jsonb_build_object('timetable_version_id', v_dup));
  end if;
  insert into app.timetable_versions (school_id, academic_year_id, section_id, period_schedule_id, effective_from,
                                      copied_from_id, created_by)
  values (c.school_id, v_sec.academic_year_id, v_sec.id, v_src.period_schedule_id, p_effective_from, v_src.id, c.account_id)
  returning id into v_id;
  insert into app.timetable_entries (school_id, timetable_version_id, weekday, slot_ordinal, subject_id, staff_id)
  select c.school_id, v_id, weekday, slot_ordinal, subject_id, case when coalesce(p_keep_teachers, false) then staff_id end
    from app.timetable_entries where timetable_version_id = v_src.id;
  return jsonb_build_object('timetable_version_id', v_id, 'status', 'draft',
                            'conflicts', private.timetable_conflicts(v_id));
exception when others then
  get stacked diagnostics v_es = returned_sqlstate, v_ec = constraint_name, v_et = table_name, v_eo = column_name,
                          v_em = message_text, v_ed = pg_exception_detail, v_eh = pg_exception_hint;
  perform private.raise_db_error(v_es, v_ec, v_et, v_eo, v_em, v_ed, v_eh);
end $$;

-- -----------------------------------------------------------------------------
-- M2 functions: duplicate-safe creates, can_check flag
-- -----------------------------------------------------------------------------
create or replace function private.save_timetable_draft(p_rev integer, p_section_id uuid, p_period_schedule_id uuid,
                                                        p_effective_from date, p_entries jsonb, p_version_id uuid,
                                                        p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_sec record; tv app.timetable_versions; v_x jsonb; v_dup uuid;
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
    v_dup := private.tt_existing_draft(c.school_id, v_sec.id, p_effective_from);
    if v_dup is not null then
      perform private.fail('DUPLICATE', 'This section already has a draft starting on this date. Open it instead.',
                           jsonb_build_object('timetable_version_id', v_dup));
    end if;
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


create or replace function private.save_homework(p_rev integer, p_assignment_id uuid, p_lesson_session_id bigint,
                                                 p_due_on date, p_description text, p_status text, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_ls app.lesson_sessions; v_hw app.homework_assignments; v_dup uuid;
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
    select * into v_ls from app.lesson_sessions where id = p_lesson_session_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Lesson not found'); end if;
    if not private.can_teach_lesson(c.role, c.staff_id, v_ls) then
      perform private.fail('FORBIDDEN', 'Only the teacher who took this lesson (or Admin) can set its homework');
    end if;
    if v_ls.status <> 'scheduled' then perform private.fail('VALIDATION_ERROR', 'Lesson was cancelled'); end if;
    if p_description is null then perform private.fail('VALIDATION_ERROR', 'Describe the homework'); end if;
    if p_due_on is null then perform private.fail('VALIDATION_ERROR', 'Choose a due date'); end if;
    if p_due_on < v_ls.session_date then perform private.fail('VALIDATION_ERROR', 'Due date can''t be before the lesson date'); end if;
    -- the same homework twice on one lesson is a retry, never a second assignment
    select id into v_dup from app.homework_assignments
     where lesson_session_id = v_ls.id and status = 'active' and description = btrim(p_description) limit 1;
    if v_dup is not null then
      perform private.fail('DUPLICATE', 'This homework is already set for this lesson',
                           jsonb_build_object('assignment_id', v_dup,
                                              'version', (select version from app.homework_assignments where id = v_dup)));
    end if;
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
    'can_check', v_hw.status = 'active' and private.can_check_homework(c.role, c.staff_id, v_hw, private.school_today(c.school_id)),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
        'student_id', e.student_id, 'roll_no', e.roll_no, 'name', e.full_name,
        'state', case when hc.id is null then 'unchecked' else hc.completion end,
        'correction', hc.correction, 'observed_on', hc.observed_on, 'completed_on', hc.completed_on,
        'comment', hc.comment, 'version', hc.version) order by e.roll_no nulls last, e.full_name)
      from private.eligible_students(v_hw.section_id, v_hw.assigned_on) e
      left join app.homework_checks hc on hc.assignment_id = v_hw.id and hc.student_id = e.student_id), '[]'::jsonb));
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
        'section', (select cl.name || ' ' || s.name from app.sections s join app.classes cl on cl.id = s.class_id where s.id = h.section_id),
        'subject_id', h.subject_id, 'subject', (select name from app.subjects where id = h.subject_id),
        'assigned_on', h.assigned_on, 'due_on', h.due_on, 'version', h.version,
        'eligible', (select count(*) from private.eligible_students(h.section_id, h.assigned_on)),
        'checked', (select count(*) from app.homework_checks hc where hc.assignment_id = h.id)) order by h.due_on, h.id)
      from app.homework_assignments h
     where h.school_id = c.school_id and h.status = 'active' and h.assigned_by_staff = c.staff_id
       and h.due_on between v_date - 14 and v_date), '[]'));
end $$;

-- -----------------------------------------------------------------------------
-- Public wrappers
-- -----------------------------------------------------------------------------
create or replace function public.save_staff_group(p_ctx_rev integer, p_name text, p_status text default 'active', p_default_salary_paise bigint default null, p_id uuid default null, p_expected_version integer default null, p_clear_default_salary boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_staff_group(p_ctx_rev, p_name, p_status, p_default_salary_paise, p_id, p_expected_version, p_clear_default_salary) $$;
create or replace function public.activate_timetable(p_ctx_rev integer, p_version_id uuid, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.activate_timetable(p_ctx_rev, p_version_id, p_expected_version) $$;
create or replace function public.copy_timetable(p_ctx_rev integer, p_from_version_id uuid, p_target_section_id uuid, p_effective_from date, p_keep_teachers boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$ select private.copy_timetable(p_ctx_rev, p_from_version_id, p_target_section_id, p_effective_from, p_keep_teachers) $$;

-- Lockdown (same block as 1400)
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.raise_db_error(text, text, text, text, text, text, text),
  private.save_staff_group(integer, text, text, bigint, uuid, integer, boolean),
  private.activate_timetable(integer, uuid, integer),
  private.tt_existing_draft(uuid, uuid, date),
  private.copy_timetable(integer, uuid, uuid, date, boolean)
to authenticated;
grant execute on function
  public.save_staff_group(integer, text, text, bigint, uuid, integer, boolean),
  public.activate_timetable(integer, uuid, integer),
  public.copy_timetable(integer, uuid, uuid, date, boolean)
to authenticated;
grant execute on all functions in schema public  to service_role;
grant execute on all functions in schema private to service_role;
