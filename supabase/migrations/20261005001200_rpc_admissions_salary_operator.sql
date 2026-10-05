-- =============================================================================
-- PrimeCampus V1 — 1200 Admissions & conversion (PRD §8), salary calculator
-- (PRD SAL-01), Operator console (PRD §14)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Leads
-- -----------------------------------------------------------------------------
create or replace function private.save_lead(p_rev integer, p_lead_id uuid, p_lead jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_id uuid; v_ver integer;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('admissions.manage');
  if p_lead ? 'stage' and p_lead->>'stage' = 'converted' then
    perform private.fail('VALIDATION_ERROR', 'Use convert/admit to mark a lead converted');
  end if;
  if p_lead_id is null then
    insert into app.leads (school_id, academic_year_id, parent_name, phone, alt_phone, email, child_name, child_dob,
                           interested_class_id, source, source_detail, assigned_to, next_follow_up_on, notes, created_by)
    values (c.school_id, (p_lead->>'academic_year_id')::uuid, p_lead->>'parent_name', p_lead->>'phone',
            p_lead->>'alt_phone', p_lead->>'email', p_lead->>'child_name', (p_lead->>'child_dob')::date,
            (p_lead->>'interested_class_id')::uuid, p_lead->>'source', p_lead->>'source_detail',
            coalesce((p_lead->>'assigned_to')::uuid, c.account_id), (p_lead->>'next_follow_up_on')::date,
            p_lead->>'notes', c.account_id)
    returning id, version into v_id, v_ver;
  else
    update app.leads set
      parent_name = coalesce(p_lead->>'parent_name', parent_name), phone = coalesce(p_lead->>'phone', phone),
      alt_phone = case when p_lead ? 'alt_phone' then p_lead->>'alt_phone' else alt_phone end,
      email = case when p_lead ? 'email' then p_lead->>'email' else email end,
      child_name = case when p_lead ? 'child_name' then p_lead->>'child_name' else child_name end,
      child_dob = case when p_lead ? 'child_dob' then (p_lead->>'child_dob')::date else child_dob end,
      interested_class_id = case when p_lead ? 'interested_class_id' then (p_lead->>'interested_class_id')::uuid else interested_class_id end,
      source = coalesce(p_lead->>'source', source), source_detail = coalesce(p_lead->>'source_detail', source_detail),
      stage = coalesce(p_lead->>'stage', stage), lost_reason = case when p_lead ? 'lost_reason' then p_lead->>'lost_reason' else lost_reason end,
      assigned_to = coalesce((p_lead->>'assigned_to')::uuid, assigned_to),
      next_follow_up_on = case when p_lead ? 'next_follow_up_on' then (p_lead->>'next_follow_up_on')::date else next_follow_up_on end,
      notes = case when p_lead ? 'notes' then p_lead->>'notes' else notes end
    where id = p_lead_id and school_id = c.school_id and version = p_expected_version and stage <> 'converted'
    returning id, version into v_id, v_ver;
    if v_id is null then perform private.fail('CONFLICT', 'Lead changed, was converted, or does not exist. Reload.'); end if;
  end if;
  return jsonb_build_object('lead_id', v_id, 'version', v_ver,
    -- suggestions only: a shared household phone can carry several genuine enquiries
    'possible_duplicates', coalesce((select jsonb_agg(jsonb_build_object('lead_id', l.id, 'parent_name', l.parent_name,
                                       'child_name', l.child_name, 'stage', l.stage))
                                      from app.leads l where l.school_id = c.school_id and l.id <> v_id
                                        and l.phone = (select phone from app.leads where id = v_id)), '[]'::jsonb));
end $$;

create or replace function private.record_lead_followup(p_rev integer, p_lead_id uuid, p_contacted_at timestamptz,
                                                        p_channel text, p_outcome text, p_note text,
                                                        p_next_follow_up_on date, p_stage text, p_lost_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_lead app.leads; v_id uuid;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('admissions.manage');
  select * into v_lead from app.leads where id = p_lead_id and school_id = c.school_id for update;
  if not found then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if v_lead.stage = 'converted' then perform private.fail('VALIDATION_ERROR', 'Lead is already converted'); end if;
  if p_stage = 'converted' then perform private.fail('VALIDATION_ERROR', 'Use convert/admit to convert a lead'); end if;
  insert into app.lead_followups (school_id, lead_id, contacted_at, channel, outcome, note, next_follow_up_on, created_by)
  values (c.school_id, p_lead_id, coalesce(p_contacted_at, now()), p_channel, p_outcome, p_note, p_next_follow_up_on, c.account_id)
  returning id into v_id;
  update app.leads
     set next_follow_up_on = p_next_follow_up_on,
         stage = coalesce(p_stage, case when stage = 'new' then 'contacted' else stage end),
         lost_reason = coalesce(p_lost_reason, lost_reason)
   where id = p_lead_id;
  return jsonb_build_object('followup_id', v_id);
end $$;

create or replace function private.get_followups_due(p_rev integer, p_days_ahead integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; v_today date;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('admissions.manage');
  v_today := private.school_today(c.school_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'lead_id', l.id, 'parent_name', l.parent_name, 'phone', l.phone, 'child_name', l.child_name,
      'stage', l.stage, 'next_follow_up_on', l.next_follow_up_on, 'assigned_to', l.assigned_to,
      'bucket', case when l.next_follow_up_on < v_today then 'overdue'
                     when l.next_follow_up_on = v_today then 'today' else 'upcoming' end,
      'last_contact', (select max(contacted_at) from app.lead_followups f where f.lead_id = l.id))
      order by l.next_follow_up_on)
    from app.leads l
   where l.school_id = c.school_id and l.stage not in ('converted','lost')
     and l.next_follow_up_on <= v_today + coalesce(p_days_ahead, 7)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Admission: direct or from a lead. One student per lead, even on retry (AC-09).
-- p_student: core profile fields; p_sensitive: optional (Admin only)
-- p_guardians: [{guardian_id} | {full_name, phone, ...}, relationship, is_primary, portal_access]
-- -----------------------------------------------------------------------------
create or replace function private.admit_student(p_rev integer, p_operation_id uuid, p_lead_id uuid, p_student jsonb,
                                                 p_sensitive jsonb, p_guardians jsonb, p_section_id uuid,
                                                 p_joined_on date, p_roll_no text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c record; v_lead app.leads; v_sec record; v_sid uuid; v_eid uuid; v_pid uuid; g jsonb; v_gid uuid;
  v_gids jsonb := '[]'; v_fp text; v_prev jsonb; v_login_pending boolean;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('admissions.manage');

  if p_lead_id is not null then
    select * into v_lead from app.leads where id = p_lead_id and school_id = c.school_id for update;
    if not found then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
    if v_lead.converted_student_id is not null then
      return jsonb_build_object('student_id', v_lead.converted_student_id, 'replayed', true,
                                'message', 'This enquiry was already converted');
    end if;
  end if;
  v_fp := private.fingerprint(jsonb_build_object('l', p_lead_id, 's', p_student, 'g', p_guardians, 'sec', p_section_id,
                                                 'j', p_joined_on, 'r', p_roll_no));
  v_prev := private.idem_lookup(c.school_id, 'admissions.admit', p_operation_id, v_fp);
  if v_prev is not null then return v_prev; end if;

  select s.id, s.academic_year_id, ay.start_date, ay.end_date into v_sec
    from app.sections s join app.academic_years ay on ay.id = s.academic_year_id
   where s.id = p_section_id and s.school_id = c.school_id and s.status = 'active';
  if v_sec.id is null then perform private.fail('VALIDATION_ERROR', 'Choose an active section'); end if;
  if p_joined_on not between v_sec.start_date and v_sec.end_date then
    perform private.fail('VALIDATION_ERROR', 'Joining date must be inside the section''s academic year');
  end if;
  if jsonb_typeof(p_guardians) <> 'array' or jsonb_array_length(p_guardians) = 0 then
    perform private.fail('VALIDATION_ERROR', 'Link at least one parent/guardian');
  end if;
  if exists (select 1 from app.students where school_id = c.school_id and upper(admission_no) = upper(p_student->>'admission_no')) then
    perform private.fail('DUPLICATE', 'Admission number already exists');
  end if;

  insert into app.students (school_id, admission_no, full_name, gender, date_of_birth, mother_name, father_name,
                            guardian_name, address_line, pincode, mobile, alt_mobile, email, mother_tongue,
                            is_indian_national, nationality, blood_group, admission_date, previous_school,
                            previous_class, created_by, updated_by)
  values (c.school_id, p_student->>'admission_no', p_student->>'full_name', p_student->>'gender',
          (p_student->>'date_of_birth')::date, p_student->>'mother_name', p_student->>'father_name',
          p_student->>'guardian_name', p_student->>'address_line', p_student->>'pincode', p_student->>'mobile',
          p_student->>'alt_mobile', p_student->>'email', p_student->>'mother_tongue',
          coalesce((p_student->>'is_indian_national')::boolean, true), p_student->>'nationality',
          p_student->>'blood_group', coalesce((p_student->>'admission_date')::date, p_joined_on),
          p_student->>'previous_school', p_student->>'previous_class', c.account_id, c.account_id)
  returning id into v_sid;

  if p_sensitive is not null and p_sensitive <> '{}'::jsonb then
    perform private.require_cap('students.sensitive');
    insert into app.student_sensitive (student_id, school_id, name_as_per_aadhaar, aadhaar_number, student_national_code,
                                       apaar_id, social_category, minority_group, is_bpl, is_aay, is_ews_disadvantaged,
                                       is_cwsn, impairment_type, has_disability_cert, disability_percent,
                                       is_out_of_school_child, mainstreamed_in, family_annual_income_paise, updated_by)
    select v_sid, c.school_id, r.name_as_per_aadhaar, r.aadhaar_number, r.student_national_code, r.apaar_id,
           r.social_category, r.minority_group, r.is_bpl, r.is_aay, r.is_ews_disadvantaged, r.is_cwsn,
           r.impairment_type, r.has_disability_cert, r.disability_percent, r.is_out_of_school_child,
           r.mainstreamed_in, r.family_annual_income_paise, c.account_id
      from jsonb_populate_record(null::app.student_sensitive, p_sensitive) r;
  end if;

  for g in select * from jsonb_array_elements(p_guardians) loop
    if g ? 'guardian_id' then
      select id into v_gid from app.guardians where id = (g->>'guardian_id')::uuid and school_id = c.school_id;
      if v_gid is null then perform private.fail('VALIDATION_ERROR', 'Linked guardian not found in this school'); end if;
    else
      insert into app.guardians (school_id, full_name, phone, alt_phone, email, occupation, address_line, created_by)
      values (c.school_id, g->>'full_name', g->>'phone', g->>'alt_phone', g->>'email', g->>'occupation',
              coalesce(g->>'address_line', p_student->>'address_line'), c.account_id)
      returning id into v_gid;
    end if;
    insert into app.student_guardians (school_id, student_id, guardian_id, relationship, is_primary, portal_access)
    values (c.school_id, v_sid, v_gid, coalesce(g->>'relationship', 'guardian'),
            coalesce((g->>'is_primary')::boolean, false), coalesce((g->>'portal_access')::boolean, true));
    v_gids := v_gids || to_jsonb(v_gid);
  end loop;

  insert into app.enrollments (school_id, academic_year_id, student_id, joined_on, created_by)
  values (c.school_id, v_sec.academic_year_id, v_sid, p_joined_on, c.account_id) returning id into v_eid;
  insert into app.placements (school_id, academic_year_id, enrollment_id, student_id, section_id, roll_no,
                              effective_from, reason, created_by)
  values (c.school_id, v_sec.academic_year_id, v_eid, v_sid, p_section_id, p_roll_no, p_joined_on, 'Admission', c.account_id)
  returning id into v_pid;

  if p_lead_id is not null then
    update app.leads set stage = 'converted', converted_student_id = v_sid, converted_at = now(), next_follow_up_on = null
     where id = p_lead_id;
  end if;

  v_login_pending := not exists (select 1 from app.guardians where id in (select (x #>> '{}')::uuid from jsonb_array_elements(v_gids) x)
                                    and account_id is not null);
  v_prev := jsonb_build_object('student_id', v_sid, 'enrollment_id', v_eid, 'placement_id', v_pid,
                               'guardian_ids', v_gids, 'lead_id', p_lead_id,
                               'parent_login_pending', v_login_pending,
                               'next_step', 'Issue term invoices for this student from Fees');
  perform private.log_event(case when p_lead_id is null then 'admissions.direct_admit' else 'admissions.lead_converted' end,
                            'students', v_sid::text, v_prev, p_operation_id, v_sec.academic_year_id);
  perform private.idem_store(c.school_id, 'admissions.admit', p_operation_id, v_fp, v_prev);
  return v_prev;
end $$;

-- -----------------------------------------------------------------------------
-- Salary calculator. payable = round(salary × P / W), P = attended + paid leave.
-- W counts the staff group's working-day weights for the whole month; days before
-- joining / after leaving are inside W but cannot be paid (pro-rates naturally and
-- is flagged). Unmarked working days are flagged, never silently "absent".
-- -----------------------------------------------------------------------------
create or replace function private.compute_salary(p_school uuid, p_staff uuid, p_month date, p_overrides jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_st app.staff; d date; r record; v_att text; v_leave numeric; v_w numeric := 0; v_a numeric := 0; v_p numeric := 0;
  v_credit numeric; v_salary bigint; v_disc jsonb := '[]'; v_unmarked jsonb := '[]'; v_end date;
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
    'payable_paise', case when v_w > 0 and v_salary is not null and v_a + v_p <= v_w and v_a >= 0 and v_p >= 0
                          then round(v_salary * (v_a + v_p) / v_w) end,
    'needs_manual_resolution', v_w <= 0 or v_salary is null,
    'resolution_reason', case when v_salary is null then 'No salary rate recorded'
                              when v_w <= 0 then 'No working days in this month for this staff calendar' end,
    'unmarked_working_dates', v_unmarked, 'discrepancies', v_disc, 'overrides', v_ov);
end $$;

create or replace function private.preview_salary(p_rev integer, p_staff_id uuid, p_month date, p_overrides jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.manage');
  return private.compute_salary(c.school_id, p_staff_id, p_month, p_overrides);
end $$;

create or replace function private.save_salary_calculation(p_rev integer, p_staff_id uuid, p_month date,
                                                           p_overrides jsonb, p_override_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v jsonb; v_prev app.salary_calculations; v_id uuid; v_month date := date_trunc('month', p_month)::date;
begin
  select * into c from private.require_ctx(p_rev);
  perform private.require_cap('staff_finance.manage');
  if coalesce(p_overrides, '{}'::jsonb) <> '{}'::jsonb and coalesce(btrim(p_override_reason), '') = '' then
    perform private.fail('VALIDATION_ERROR', 'Overrides need a reason');
  end if;
  v := private.compute_salary(c.school_id, p_staff_id, v_month, p_overrides);
  if (v->>'needs_manual_resolution')::boolean then
    perform private.fail('VALIDATION_ERROR', coalesce(v->>'resolution_reason', 'Manual resolution needed') ||
                         '. Enter overrides with a reason.', v);
  end if;
  if (v->>'payable_paise') is null then
    perform private.fail('VALIDATION_ERROR', 'Paid days cannot exceed working days or be negative', v);
  end if;
  select * into v_prev from app.salary_calculations where staff_id = p_staff_id and month = v_month and status = 'final' for update;
  if found then
    update app.salary_calculations set status = 'superseded' where id = v_prev.id;
  end if;
  insert into app.salary_calculations (school_id, staff_id, month, version_no, supersedes_id, monthly_salary_paise,
                                       working_days, attended_days, paid_leave_days, unpaid_days, payable_paise,
                                       discrepancies, overrides, override_reason, inputs, calculated_by)
  values (c.school_id, p_staff_id, v_month, coalesce(v_prev.version_no, 0) + 1, v_prev.id,
          (v->>'monthly_salary_paise')::bigint, (v->>'working_days')::numeric, (v->>'attended_days')::numeric,
          (v->>'paid_leave_days')::numeric, (v->>'unpaid_days')::numeric, (v->>'payable_paise')::bigint,
          jsonb_build_object('unmarked_working_dates', v->'unmarked_working_dates', 'items', v->'discrepancies'),
          coalesce(p_overrides, '{}'), p_override_reason,
          jsonb_build_object('computed_at', now(), 'calendar', 'staff', 'staff_group_id',
                             (select staff_group_id from app.staff where id = p_staff_id)),
          c.account_id)
  returning id into v_id;
  return v || jsonb_build_object('salary_calculation_id', v_id, 'version_no', coalesce(v_prev.version_no, 0) + 1);
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
      'override_reason', sc.override_reason, 'created_at', sc.created_at) order by s.full_name, sc.version_no desc)
    from app.salary_calculations sc join app.staff s on s.id = sc.staff_id
   where sc.school_id = c.school_id
     and (p_month is null or sc.month = date_trunc('month', p_month)::date)
     and (p_staff_id is null or sc.staff_id = p_staff_id)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Operator console (raw logs are Operator-only)
-- -----------------------------------------------------------------------------
create or replace function private.require_operator()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.platform_operators po
                   join private.app_sessions s on s.account_id = po.account_id
                  where po.account_id = auth.uid() and po.revoked_at is null
                    and s.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid and s.ended_at is null) then
    perform private.fail('FORBIDDEN', 'Operator access required');
  end if;
end $$;

create or replace function private.op_get_audit_events(p_school_id uuid, p_actor_id uuid, p_action_prefix text,
                                                       p_entity_id text, p_from timestamptz, p_to timestamptz,
                                                       p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform private.require_operator();
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') into v_items from (
    select * from private.audit_events
     where (p_school_id is null or school_id = p_school_id)
       and (p_actor_id is null or actor_id = p_actor_id)
       and (p_action_prefix is null or action like p_action_prefix || '%')
       and (p_entity_id is null or entity_id = p_entity_id)
       and (p_from is null or occurred_at >= p_from) and (p_to is null or occurred_at < p_to)
       and (p_before_id is null or id < p_before_id)
     order by id desc limit least(coalesce(p_limit, 50), 100)) e;
  return jsonb_build_object('items', v_items,
                            'next_before_id', (select min((x->>'id')::bigint) from jsonb_array_elements(v_items) x));
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
                            'next_before_id', (select min((x->>'id')::bigint) from jsonb_array_elements(v_items) x));
end $$;

-- Usage: authenticated sessions vs last seen vs estimated activity (all labelled approximate)
create or replace function private.op_get_usage(p_school_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_operator();
  return jsonb_build_object(
    'note', 'Page views and activity are browser-reported estimates; last seen is not a logout time.',
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'active_accounts', n, 'page_views', pv) order by day)
               from (select day, count(distinct account_id) n, sum(page_views) pv from private.usage_daily
                      where (p_school_id is null or school_id = p_school_id) and day between p_from and p_to group by day) q), '[]'),
    'logins', (select count(*) from private.auth_events where event = 'login'
                  and (p_school_id is null or school_id = p_school_id or school_id is null)
                  and occurred_at::date between p_from and p_to),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('account', a.username, 'started', s.created_at,
                                                             'last_seen', s.last_seen_at, 'ended', s.ended_at,
                                                             'end_reason', s.end_reason, 'device_class', s.device_class)
                                           order by s.last_seen_at desc)
               from private.app_sessions s join app.accounts a on a.id = s.account_id
              where s.last_seen_at::date between p_from and p_to
                and (p_school_id is null or exists (select 1 from app.memberships m where m.account_id = s.account_id
                                                      and m.school_id = p_school_id))
              limit 200), '[]'));
end $$;

-- Bounded retention cleanup for telemetry / aggregates / auth history. Never touches business ledgers.
create or replace function private.op_run_retention_cleanup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t integer; v_u integer; v_a integer;
begin
  perform private.require_operator();
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
  perform private.log_event('operator.retention_cleanup', 'private', null,
                            jsonb_build_object('telemetry', v_t, 'usage_daily', v_u, 'auth_events', v_a));
  return jsonb_build_object('telemetry_deleted', v_t, 'usage_daily_deleted', v_u, 'auth_events_deleted', v_a);
end $$;

create or replace function private.op_create_school(p_organization jsonb, p_school jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_school uuid;
begin
  perform private.require_operator();
  if p_organization ? 'id' then
    v_org := (p_organization->>'id')::uuid;
  else
    insert into app.organizations (name, code) values (p_organization->>'name', p_organization->>'code') returning id into v_org;
  end if;
  insert into app.schools (organization_id, name, code, udise_code, board, phone, email, address_line, city, district, pincode)
  values (v_org, p_school->>'name', p_school->>'code', p_school->>'udise_code', p_school->>'board', p_school->>'phone',
          p_school->>'email', p_school->>'address_line', p_school->>'city', p_school->>'district', p_school->>'pincode')
  returning id into v_school;
  perform private.log_event('operator.school_created', 'schools', v_school::text, p_school);
  return jsonb_build_object('organization_id', v_org, 'school_id', v_school);
end $$;

-- ---------------------------------------------------------------- public wrappers
create or replace function public.save_lead(p_ctx_rev integer, p_lead jsonb, p_lead_id uuid default null, p_expected_version integer default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_lead(p_ctx_rev, p_lead_id, p_lead, p_expected_version) $$;
create or replace function public.record_lead_followup(p_ctx_rev integer, p_lead_id uuid, p_channel text, p_outcome text, p_note text default null, p_next_follow_up_on date default null, p_stage text default null, p_lost_reason text default null, p_contacted_at timestamptz default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.record_lead_followup(p_ctx_rev, p_lead_id, p_contacted_at, p_channel, p_outcome, p_note, p_next_follow_up_on, p_stage, p_lost_reason) $$;
create or replace function public.get_followups_due(p_ctx_rev integer, p_days_ahead integer default 7)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_followups_due(p_ctx_rev, p_days_ahead) $$;
create or replace function public.admit_student(p_ctx_rev integer, p_operation_id uuid, p_student jsonb, p_guardians jsonb, p_section_id uuid, p_joined_on date, p_roll_no text default null, p_lead_id uuid default null, p_sensitive jsonb default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.admit_student(p_ctx_rev, p_operation_id, p_lead_id, p_student, p_sensitive, p_guardians, p_section_id, p_joined_on, p_roll_no) $$;
create or replace function public.preview_salary(p_ctx_rev integer, p_staff_id uuid, p_month date, p_overrides jsonb default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.preview_salary(p_ctx_rev, p_staff_id, p_month, p_overrides) $$;
create or replace function public.save_salary_calculation(p_ctx_rev integer, p_staff_id uuid, p_month date, p_overrides jsonb default null, p_override_reason text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_salary_calculation(p_ctx_rev, p_staff_id, p_month, p_overrides, p_override_reason) $$;
create or replace function public.get_salary_calculations(p_ctx_rev integer, p_month date default null, p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.get_salary_calculations(p_ctx_rev, p_month, p_staff_id) $$;
create or replace function public.op_get_audit_events(p_school_id uuid default null, p_actor_id uuid default null, p_action_prefix text default null, p_entity_id text default null, p_from timestamptz default null, p_to timestamptz default null, p_before_id bigint default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_get_audit_events(p_school_id, p_actor_id, p_action_prefix, p_entity_id, p_from, p_to, p_before_id, p_limit) $$;
create or replace function public.op_get_auth_events(p_account_id uuid default null, p_school_id uuid default null, p_from timestamptz default null, p_to timestamptz default null, p_before_id bigint default null, p_limit integer default 50)
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_get_auth_events(p_account_id, p_school_id, p_from, p_to, p_before_id, p_limit) $$;
create or replace function public.op_get_usage(p_from date, p_to date, p_school_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_get_usage(p_school_id, p_from, p_to) $$;
create or replace function public.op_run_retention_cleanup()
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_run_retention_cleanup() $$;
create or replace function public.op_create_school(p_organization jsonb, p_school jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.op_create_school(p_organization, p_school) $$;

grant execute on function
  private.save_lead(integer, uuid, jsonb, integer),
  private.record_lead_followup(integer, uuid, timestamptz, text, text, text, date, text, text),
  private.get_followups_due(integer, integer),
  private.admit_student(integer, uuid, uuid, jsonb, jsonb, jsonb, uuid, date, text),
  private.preview_salary(integer, uuid, date, jsonb), private.save_salary_calculation(integer, uuid, date, jsonb, text),
  private.get_salary_calculations(integer, date, uuid),
  private.op_get_audit_events(uuid, uuid, text, text, timestamptz, timestamptz, bigint, integer),
  private.op_get_auth_events(uuid, uuid, timestamptz, timestamptz, bigint, integer),
  private.op_get_usage(uuid, date, date), private.op_run_retention_cleanup(), private.op_create_school(jsonb, jsonb)
to authenticated;
grant execute on function
  public.save_lead(integer, jsonb, uuid, integer),
  public.record_lead_followup(integer, uuid, text, text, text, date, text, text, timestamptz),
  public.get_followups_due(integer, integer),
  public.admit_student(integer, uuid, jsonb, jsonb, uuid, date, text, uuid, jsonb),
  public.preview_salary(integer, uuid, date, jsonb), public.save_salary_calculation(integer, uuid, date, jsonb, text),
  public.get_salary_calculations(integer, date, uuid),
  public.op_get_audit_events(uuid, uuid, text, text, timestamptz, timestamptz, bigint, integer),
  public.op_get_auth_events(uuid, uuid, timestamptz, timestamptz, bigint, integer),
  public.op_get_usage(date, date, uuid), public.op_run_retention_cleanup(), public.op_create_school(jsonb, jsonb)
to authenticated;
