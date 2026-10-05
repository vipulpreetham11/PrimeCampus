-- =============================================================================
-- PrimeCampus V1 — 0800 Security: active context, capabilities, audit trigger, RLS
--
-- Model (TRD §7):
--  * The JWT proves WHO (auth.uid) and WHICH provider session (session_id claim).
--  * private.app_sessions holds the server-chosen school / role / child for that
--    session. Nothing is read from user_metadata or browser storage.
--  * Every policy is scoped by (select private.ctx_school_id()) and a capability
--    derived from the *selected* role only — Teacher + Parent grants never union.
--  * Ledger / attendance / audit tables have NO direct write grants: they change
--    only through the SECURITY DEFINER routines in 0900+, which re-check context.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Context resolution
-- -----------------------------------------------------------------------------
create or replace function private.ctx()
returns table (
  account_id        uuid,
  app_session_id    uuid,
  school_id         uuid,
  role              text,
  membership_id     uuid,
  student_id        uuid,
  staff_id          uuid,
  via_operator      boolean,
  context_revision  integer,
  admissions_duty   boolean
)
language sql stable security definer set search_path = '' as $$
  select s.account_id,
         s.id,
         coalesce(m.school_id, s.operator_school_id),
         case when s.operator_school_id is not null then 'operator' else m.role end,
         m.id,
         s.student_id,
         (select st.id from app.staff st
           where st.account_id = s.account_id
             and st.school_id = coalesce(m.school_id, s.operator_school_id)
             and st.status = 'active'),
         s.operator_school_id is not null,
         s.context_revision,
         coalesce(m.admissions_duty, false)
  from private.app_sessions s
  join app.accounts a
    on a.id = s.account_id and a.status = 'active' and not a.must_change_password
  left join app.memberships m
    on m.id = s.membership_id and m.status = 'active'
  where s.account_id = auth.uid()
    and s.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
    and s.ended_at is null
    and (
      m.id is not null
      or (s.operator_school_id is not null
          and exists (select 1 from private.platform_operators po
                       where po.account_id = s.account_id and po.revoked_at is null))
    )
$$;

create or replace function private.ctx_school_id()  returns uuid language sql stable security definer set search_path = '' as $$ select school_id  from private.ctx() $$;
create or replace function private.ctx_role()       returns text language sql stable security definer set search_path = '' as $$ select role       from private.ctx() $$;
create or replace function private.ctx_account_id() returns uuid language sql stable security definer set search_path = '' as $$ select account_id from private.ctx() $$;
create or replace function private.ctx_staff_id()   returns uuid language sql stable security definer set search_path = '' as $$ select staff_id   from private.ctx() $$;

-- Selected child (Parent) or own record (Student) — re-validated live every call
create or replace function private.ctx_child_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select c.student_id
  from private.ctx() c
  where (c.role = 'parent' and exists (
            select 1 from app.student_guardians sg
            join app.guardians g on g.id = sg.guardian_id
           where sg.student_id = c.student_id and sg.portal_access
             and g.account_id = c.account_id and g.status = 'active'))
     or (c.role = 'student' and exists (
            select 1 from app.students st
           where st.id = c.student_id and st.account_id = c.account_id and st.status = 'active'))
$$;

create or replace function private.school_today(p_school_id uuid)
returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce((select timezone from app.schools where id = p_school_id), 'Asia/Kolkata'))::date
$$;

-- -----------------------------------------------------------------------------
-- Capabilities: one place maps role -> permission (PRD §4, TRD §7.2)
-- -----------------------------------------------------------------------------
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
    else false end, false)
$$;

create or replace function private.has_cap(p_cap text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.role_has_cap(c.role, p_cap)
           or (p_cap = 'admissions.manage' and c.admissions_duty)
    from private.ctx() c), false)
$$;

-- Students the current Teacher / Parent / Student context may see (row scope).
-- Admin/Principal/Accountant/Operator use 'students.read_all' instead.
create or replace function private.scoped_student_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  with c as (select * from private.ctx()),
       d as (select private.school_today(c.school_id) as today from c)
  -- Teacher: students currently placed in a section they teach / class-teach
  select p.student_id
    from c, d
    join app.teaching_assignments ta on true
    join app.placements p on p.section_id = ta.section_id
   where c.role = 'teacher'
     and ta.staff_id = c.staff_id
     and ta.effective_from <= d.today and (ta.effective_to is null or ta.effective_to > d.today)
     and p.effective_from <= d.today and (p.effective_to is null or p.effective_to > d.today)
  union
  -- Teacher: sections of lessons they actually take (incl. substitutions) ±7 days
  select p.student_id
    from c, d
    join app.lesson_sessions ls on true
    join app.placements p on p.section_id = ls.section_id
   where c.role = 'teacher'
     and ls.actual_staff_id = c.staff_id
     and ls.session_date between d.today - 7 and d.today + 7
     and p.effective_from <= ls.session_date and (p.effective_to is null or p.effective_to > ls.session_date)
  union
  select private.ctx_child_id() where private.ctx_child_id() is not null
$$;

-- Sections a Teacher is (or was this year) responsible for
create or replace function private.teacher_section_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select ta.section_id from app.teaching_assignments ta, private.ctx() c
   where c.role = 'teacher' and ta.staff_id = c.staff_id
  union
  select ls.section_id from app.lesson_sessions ls, private.ctx() c
   where c.role = 'teacher' and ls.actual_staff_id = c.staff_id
$$;

-- (section, date-window) pairs for the selected child: placement history
create or replace function private.child_section_windows()
returns table (section_id uuid, from_date date, to_date date)
language sql stable security definer set search_path = '' as $$
  select p.section_id, p.effective_from, p.effective_to
    from app.placements p
   where p.student_id = private.ctx_child_id()
$$;

-- -----------------------------------------------------------------------------
-- Generic audit trigger for configuration / master data (TRD §16.1).
-- Commits with the change; failure rolls the change back.
-- Sensitive tables log only WHICH columns changed, never values.
-- -----------------------------------------------------------------------------
create or replace function private.tg_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ctx      record;
  v_new      jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old      jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_redact   boolean := tg_table_name in ('student_sensitive','staff_bank_accounts','staff_salary_rates',
                                          'staff_group_salary_defaults','accounts');
  v_detail   jsonb;
  v_key      text;
  v_changed  jsonb := '{}';
begin
  select * into v_ctx from private.ctx();
  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key not in ('updated_at','version') and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changed := v_changed || jsonb_build_object(v_key,
          case when v_redact then '"[redacted]"'::jsonb
               else jsonb_build_array(v_old -> v_key, v_new -> v_key) end);
      end if;
    end loop;
    if v_changed = '{}'::jsonb then return new; end if;
    v_detail := jsonb_build_object('changed', v_changed);
  elsif tg_op = 'INSERT' then
    v_detail := case when v_redact then jsonb_build_object('columns', (select jsonb_agg(k) from jsonb_object_keys(v_new) k))
                     else jsonb_build_object('new', v_new) end;
  else
    v_detail := jsonb_build_object('old_id', v_old -> 'id');
  end if;
  if pg_column_size(v_detail) > 8000 then
    v_detail := jsonb_build_object('truncated', true,
                  'keys', (select jsonb_agg(k) from jsonb_object_keys(coalesce(v_changed, v_new)) k));
  end if;

  insert into private.audit_events (actor_id, actor_role, via_operator, app_session_id, school_id,
                                    action, entity_type, entity_id, detail)
  values (coalesce(v_ctx.account_id, auth.uid()), v_ctx.role, coalesce(v_ctx.via_operator, false), v_ctx.app_session_id,
          coalesce((coalesce(v_new, v_old) ->> 'school_id')::uuid, v_ctx.school_id),
          tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(coalesce(v_new, v_old) ->> 'id', coalesce(v_new, v_old) ->> 'student_id',
                   coalesce(v_new, v_old) ->> 'staff_id', coalesce(v_new, v_old) ->> 'staff_group_id'),
          v_detail);
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array[
    'schools','accounts','memberships','academic_years','classes','sections','subjects','class_subjects',
    'period_schedules','schedule_slots','calendar_patterns','calendar_days','attendance_modes','staff_groups',
    'students','student_sensitive','guardians','student_guardians','enrollments','placements','placement_batches',
    'staff','staff_salary_rates','staff_bank_accounts','staff_group_salary_defaults','teaching_assignments',
    'leads','import_jobs','timetable_versions','timetable_entries','substitutions',
    'staff_paid_leave','diary_entries','homework_assignments',
    'fee_heads','receiving_accounts','fee_terms','fee_structure_lines','student_optional_fees','concession_presets',
    'concession_preset_heads','student_concessions','late_fee_rules','invoices','invoice_adjustments',
    'cheques','payment_exceptions','salary_calculations'] loop
    execute format('create trigger %1$s_audit after insert or update or delete on app.%1$s
                    for each row execute function private.tg_audit()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Grants. app tables: SELECT for authenticated (RLS filters); writes only where a
-- policy below allows them. private: no table access at all for clients.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema app from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant select on all tables in schema app to authenticated;
grant all on all tables in schema app to service_role;
grant all on all tables in schema private to service_role;
grant usage, select on all sequences in schema app to service_role;
grant usage, select on all sequences in schema private to service_role;

grant insert, update on
  app.schools, app.academic_years, app.classes, app.sections, app.subjects, app.class_subjects,
  app.period_schedules, app.schedule_slots, app.calendar_patterns, app.calendar_days, app.attendance_modes,
  app.staff_groups, app.staff_group_salary_defaults,
  app.students, app.student_sensitive, app.guardians, app.student_guardians,
  app.staff, app.staff_salary_rates, app.staff_bank_accounts, app.teaching_assignments,
  app.leads, app.timetable_versions, app.timetable_entries, app.staff_paid_leave,
  app.fee_heads, app.receiving_accounts, app.fee_terms, app.fee_structure_lines, app.student_optional_fees,
  app.concession_presets, app.concession_preset_heads, app.student_concessions, app.late_fee_rules,
  app.payment_exceptions
to authenticated;
grant insert on app.lead_followups to authenticated;
grant delete on app.schedule_slots, app.timetable_entries, app.concession_preset_heads, app.student_guardians to authenticated;

grant execute on function
  private.ctx(), private.ctx_school_id(), private.ctx_role(), private.ctx_account_id(), private.ctx_staff_id(),
  private.ctx_child_id(), private.has_cap(text), private.role_has_cap(text, text), private.scoped_student_ids(),
  private.teacher_section_ids(), private.child_section_windows(), private.school_today(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS: enable on everything in app and private
-- -----------------------------------------------------------------------------
do $$ declare r record; begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('app','private') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
  end loop;
end $$;

-- Policy factory for the common shape:
--   SELECT  school_id = ctx school AND has_cap(read_cap)
--   INSERT/UPDATE/DELETE  school_id = ctx school AND has_cap(write_cap)   (old AND new row)
create or replace function private._school_policies(p_table text, p_read_cap text, p_write_cap text, p_ops text[])
returns void language plpgsql set search_path = '' as $$
declare
  v_scope text := 'school_id = (select private.ctx_school_id())';
  op text;
begin
  execute format('create policy %I on app.%I for select to authenticated using (%s and (select private.has_cap(%L)))',
                 p_table || '_select', p_table, v_scope, p_read_cap);
  foreach op in array p_ops loop
    if op = 'insert' then
      execute format('create policy %I on app.%I for insert to authenticated with check (%s and (select private.has_cap(%L)))',
                     p_table || '_insert', p_table, v_scope, p_write_cap);
    elsif op = 'update' then
      execute format('create policy %I on app.%I for update to authenticated using (%s and (select private.has_cap(%L))) with check (%s and (select private.has_cap(%L)))',
                     p_table || '_update', p_table, v_scope, p_write_cap, v_scope, p_write_cap);
    elsif op = 'delete' then
      execute format('create policy %I on app.%I for delete to authenticated using (%s and (select private.has_cap(%L)))',
                     p_table || '_delete', p_table, v_scope, p_write_cap);
    end if;
  end loop;
end $$;

-- Shared configuration readable by anyone in the school context
select private._school_policies('academic_years',     'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('classes',            'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('sections',           'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('subjects',           'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('class_subjects',     'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('period_schedules',   'school.member', 'setup.manage', array['insert','update']);
select private._school_policies('schedule_slots',     'school.member', 'setup.manage', array['insert','update','delete']);
select private._school_policies('attendance_modes',   'staff.member',  'setup.manage', array['insert']);
select private._school_policies('staff_groups',       'staff.member',  'setup.manage', array['insert','update']);
select private._school_policies('teaching_assignments','staff.member', 'timetable.manage', array['insert','update']);
select private._school_policies('timetable_versions', 'timetable.read_all', 'timetable.manage', array['insert','update']);
select private._school_policies('timetable_entries',  'timetable.read_all', 'timetable.manage', array['insert','update','delete']);
select private._school_policies('staff',              'staff.read',    'staff.manage', array['insert','update']);
select private._school_policies('staff_salary_rates', 'staff_finance.read', 'staff_finance.manage', array['insert']);
select private._school_policies('staff_bank_accounts','staff_finance.read', 'staff_finance.manage', array['insert','update']);
select private._school_policies('staff_group_salary_defaults','staff_finance.read','staff_finance.manage', array['insert','update']);
select private._school_policies('staff_paid_leave',   'staff_finance.read', 'staff_finance.manage', array['insert','update']);
select private._school_policies('salary_calculations','staff_finance.read', 'staff_finance.manage', array[]::text[]);
select private._school_policies('student_sensitive',  'students.sensitive', 'students.sensitive', array['insert','update']);
select private._school_policies('leads',              'admissions.manage', 'admissions.manage', array['insert','update']);
select private._school_policies('lead_followups',     'admissions.manage', 'admissions.manage', array['insert']);
select private._school_policies('import_jobs',        'imports.manage', 'imports.manage', array[]::text[]);
select private._school_policies('import_rows',        'imports.manage', 'imports.manage', array[]::text[]);
select private._school_policies('import_source_keys', 'imports.manage', 'imports.manage', array[]::text[]);
select private._school_policies('placement_batches',  'students.read_all', 'students.manage', array[]::text[]);
select private._school_policies('attendance_changes', 'attendance.read_all', 'attendance.mark_any', array[]::text[]);
select private._school_policies('homework_check_changes','academic.read_all','academic.correct', array[]::text[]);
select private._school_policies('fee_heads',          'school.member', 'fees.manage', array['insert','update']);
select private._school_policies('fee_terms',          'school.member', 'fees.manage', array['insert','update']);
select private._school_policies('receiving_accounts', 'fees.read',     'fees.manage', array['insert','update']);
select private._school_policies('fee_structure_lines','fees.read',     'fees.manage', array['insert','update']);
select private._school_policies('concession_presets', 'fees.read',     'fees.manage', array['insert','update']);
select private._school_policies('concession_preset_heads','fees.read', 'fees.manage', array['insert','delete']);
select private._school_policies('late_fee_rules',     'fees.read',     'fees.manage', array['insert','update']);
select private._school_policies('doc_sequences',      'fees.manage',   'fees.manage', array[]::text[]);
select private._school_policies('payment_exceptions', 'fees.read',     'fees.manage', array['insert','update']);

-- Calendars: student calendar visible to all members; staff calendar to staff roles
create policy calendar_patterns_select on app.calendar_patterns for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and (audience = 'student' or (select private.has_cap('staff.member'))));
create policy calendar_patterns_write on app.calendar_patterns for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')));
create policy calendar_patterns_update on app.calendar_patterns for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')));
create policy calendar_days_select on app.calendar_days for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and (audience = 'student' or (select private.has_cap('staff.member'))));
create policy calendar_days_insert on app.calendar_days for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')));
create policy calendar_days_update on app.calendar_days for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')));

-- Platform / identity
create policy organizations_select on app.organizations for select to authenticated
  using (id = (select organization_id from app.schools where id = (select private.ctx_school_id())));
create policy schools_select on app.schools for select to authenticated
  using (id = (select private.ctx_school_id()));
create policy schools_update on app.schools for update to authenticated
  using (id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')))
  with check (id = (select private.ctx_school_id()) and (select private.has_cap('setup.manage')));
create policy accounts_select on app.accounts for select to authenticated
  using (id = (select auth.uid())
         or ((select private.has_cap('users.manage'))
             and exists (select 1 from app.memberships m
                          where m.account_id = accounts.id and m.school_id = (select private.ctx_school_id()))));
create policy memberships_select on app.memberships for select to authenticated
  using (account_id = (select auth.uid())
         or (school_id = (select private.ctx_school_id()) and (select private.has_cap('users.manage'))));

-- Students and their links: read_all roles, or the row scope of Teacher/Parent/Student
create policy students_select on app.students for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('students.read_all'))
              or id = any (array(select private.scoped_student_ids()))));
create policy students_insert on app.students for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));
create policy students_update on app.students for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));

create policy student_guardians_select on app.student_guardians for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('students.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))));
create policy student_guardians_insert on app.student_guardians for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));
create policy student_guardians_update on app.student_guardians for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));
create policy student_guardians_delete on app.student_guardians for delete to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));

create policy guardians_select on app.guardians for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('students.read_all'))
              or account_id = (select auth.uid())
              or exists (select 1 from app.student_guardians sg
                          where sg.guardian_id = guardians.id
                            and sg.student_id = any (array(select private.scoped_student_ids())))));
create policy guardians_insert on app.guardians for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));
create policy guardians_update on app.guardians for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('students.manage')));

create policy enrollments_select on app.enrollments for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('students.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))));
create policy placements_select on app.placements for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('students.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))
              or section_id = any (array(select private.teacher_section_ids()))));

-- Lessons / substitutions: staff timetable readers, or the child's own section history
create policy lesson_sessions_select on app.lesson_sessions for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('timetable.read_all'))
              or exists (select 1 from private.child_section_windows() w
                          where w.section_id = lesson_sessions.section_id
                            and lesson_sessions.session_date >= w.from_date
                            and (w.to_date is null or lesson_sessions.session_date < w.to_date))));
create policy substitutions_select on app.substitutions for select to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('timetable.read_all')));

-- Student attendance: Admin/Principal/Operator; Teacher scope; Parent/Student own. Owner: summaries via RPC only.
create policy student_daily_attendance_select on app.student_daily_attendance for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('attendance.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))));
create policy student_period_attendance_select on app.student_period_attendance for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('attendance.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))));
create policy attendance_submissions_select on app.attendance_submissions for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('attendance.read_all')) or actor_id = (select auth.uid())));
create policy staff_attendance_select on app.staff_attendance for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('staff_attendance.read')) or staff_id = (select private.ctx_staff_id())));

-- Diary / homework: Admin/Principal/Operator; teachers of the section; child within placement window. Never Owner.
create policy diary_entries_select on app.diary_entries for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('academic.read_all'))
              or exists (select 1 from app.lesson_sessions ls
                          where ls.id = diary_entries.lesson_session_id
                            and (ls.section_id = any (array(select private.teacher_section_ids()))
                                 or exists (select 1 from private.child_section_windows() w
                                             where w.section_id = ls.section_id
                                               and ls.session_date >= w.from_date
                                               and (w.to_date is null or ls.session_date < w.to_date))))));
create policy homework_assignments_select on app.homework_assignments for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('academic.read_all'))
              or section_id = any (array(select private.teacher_section_ids()))
              or exists (select 1 from private.child_section_windows() w
                          where w.section_id = homework_assignments.section_id
                            and homework_assignments.assigned_on >= w.from_date
                            and (w.to_date is null or homework_assignments.assigned_on < w.to_date))));
create policy homework_checks_select on app.homework_checks for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('academic.read_all'))
              or student_id = any (array(select private.scoped_student_ids()))
              or exists (select 1 from app.homework_assignments ha
                          where ha.id = homework_checks.assignment_id
                            and ha.section_id = any (array(select private.teacher_section_ids())))));

-- Fee records: fee roles, or Parent/Student for the selected child only (never Teacher scope)
do $$ declare t text; begin
  foreach t in array array['student_optional_fees','student_concessions','invoices','invoice_adjustments',
                           'collections','collection_reversals','receipts','cheques'] loop
    execute format($p$
      create policy %1$s_select on app.%1$s for select to authenticated
        using (school_id = (select private.ctx_school_id())
               and ((select private.has_cap('fees.read'))
                    or student_id = (select private.ctx_child_id())))$p$, t);
  end loop;
end $$;
create policy student_optional_fees_insert on app.student_optional_fees for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage')));
create policy student_optional_fees_update on app.student_optional_fees for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage')));
create policy student_concessions_insert on app.student_concessions for insert to authenticated
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage'))
              and granted_by = (select auth.uid()));
create policy student_concessions_update on app.student_concessions for update to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage')))
  with check (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.manage')));
create policy invoice_lines_select on app.invoice_lines for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('fees.read'))
              or invoice_id in (select i.id from app.invoices i where i.student_id = (select private.ctx_child_id()))));
create policy collection_allocations_select on app.collection_allocations for select to authenticated
  using (school_id = (select private.ctx_school_id())
         and ((select private.has_cap('fees.read')) or student_id = (select private.ctx_child_id())));
create policy reversal_allocations_select on app.reversal_allocations for select to authenticated
  using (school_id = (select private.ctx_school_id()) and (select private.has_cap('fees.read')));

-- private.* has RLS enabled + forced and no policies: clients see nothing.
drop function private._school_policies(text, text, text, text[]);
