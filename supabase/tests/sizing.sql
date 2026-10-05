-- Full-year synthetic load (TRD §19): 800 students, 20 sections x 40, 220 days x 7 periods,
-- period attendance for every lesson, 2 homework tasks/section/day with a check per student.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
alter table app.student_period_attendance disable trigger user;
alter table app.homework_checks disable trigger user;
alter table app.lesson_sessions disable trigger user;
alter table app.attendance_submissions disable trigger user;
alter table app.homework_assignments disable trigger user;
do $$
declare v_school uuid; v_year uuid; v_cls uuid; v_sub uuid; v_grp uuid; v_staff uuid; v_acc uuid; i int;
begin
  insert into app.organizations (name, code) values ('Size Org','size') returning id into v_school;
  insert into app.schools (organization_id, name, code) values (v_school, 'Size School', 'size') returning id into v_school;
  insert into app.academic_years (school_id, name, start_date, end_date) values (v_school, 'SZ', '2025-06-01', '2026-04-30') returning id into v_year;
  insert into app.classes (school_id, name, sort_order) values (v_school, 'C', 1) returning id into v_cls;
  insert into app.subjects (school_id, name, code) values (v_school, 'S', 'S') returning id into v_sub;
  insert into app.staff_groups (school_id, name) values (v_school, 'G') returning id into v_grp;
  insert into app.staff (school_id, employee_no, full_name, staff_group_id, joined_on) values (v_school, 'E', 'T', v_grp, '2020-01-01') returning id into v_staff;
  insert into auth.users default values returning id into v_acc;
  insert into app.accounts (id, username, display_name, status) values (v_acc, 'size.user', 'S', 'active');
  insert into app.sections (school_id, academic_year_id, class_id, name)
    select v_school, v_year, v_cls, 'S' || g from generate_series(1, 20) g;
  insert into app.students (school_id, admission_no, full_name, gender, date_of_birth, admission_date)
    select v_school, 'ADM' || g, 'Student Name ' || g, 'male', '2015-01-01', '2025-06-01' from generate_series(1, 800) g;
  insert into app.enrollments (school_id, academic_year_id, student_id, joined_on)
    select v_school, v_year, id, '2025-06-01' from app.students where school_id = v_school;
  insert into app.placements (school_id, academic_year_id, enrollment_id, student_id, section_id, roll_no, effective_from)
    select e.school_id, e.academic_year_id, e.id, e.student_id, s.id, (row_number() over (partition by s.id))::text, '2025-06-01'
      from (select e.*, row_number() over (order by e.student_id) rn from app.enrollments e where e.school_id = v_school) e
      join (select s.*, row_number() over (order by s.name) rn from app.sections s where s.school_id = v_school) s
        on s.rn = ((e.rn - 1) / 40) + 1;
  -- 220 school days x 7 periods x 20 sections
  insert into app.lesson_sessions (school_id, academic_year_id, section_id, session_date, slot_ordinal, slot_label,
                                   start_time, end_time, subject_id, planned_staff_id, actual_staff_id)
    select v_school, v_year, s.id, d.d, p, 'P' || p, time '09:00' + (p - 1) * interval '40 min',
           time '09:40' + (p - 1) * interval '40 min', v_sub, v_staff, v_staff
      from app.sections s,
           (select ('2025-06-02'::date + g) d from generate_series(0, 300) g
             where extract(isodow from '2025-06-02'::date + g) < 7 limit 220) d,
           generate_series(1, 7) p
     where s.school_id = v_school;
  insert into app.attendance_submissions (school_id, kind, attendance_date, lesson_session_id, actor_id, actor_role, operation_id, marked_count)
    select v_school, 'student_period', ls.session_date, ls.id, v_acc, 'teacher', gen_random_uuid(), 40
      from app.lesson_sessions ls where ls.school_id = v_school;
  insert into app.student_period_attendance (lesson_session_id, student_id, school_id, attendance_date, status, submission_id)
    select ls.id, p.student_id, v_school, ls.session_date, case when random() < 0.08 then 'A' else 'P' end, sub.id
      from app.lesson_sessions ls
      join app.placements p on p.section_id = ls.section_id
      join app.attendance_submissions sub on sub.lesson_session_id = ls.id
     where ls.school_id = v_school;
  -- 2 homework tasks per section per day, each checked for every student
  insert into app.homework_assignments (school_id, academic_year_id, section_id, subject_id, lesson_session_id,
                                        assigned_by_staff, assigned_on, due_on, description, created_by)
    select v_school, v_year, ls.section_id, v_sub, ls.id, v_staff, ls.session_date, ls.session_date + 1,
           'Complete exercise ' || ls.slot_ordinal || ' from the textbook and revise notes', v_acc
      from app.lesson_sessions ls where ls.school_id = v_school and ls.slot_ordinal in (1, 4);
  insert into app.homework_checks (school_id, assignment_id, student_id, completion, observed_on, checked_by)
    select v_school, h.id, p.student_id, case when random() < 0.1 then 'not_completed' else 'completed' end,
           h.due_on, v_acc
      from app.homework_assignments h join app.placements p on p.section_id = h.section_id
     where h.school_id = v_school;
end $$;
alter table app.student_period_attendance enable trigger user;
alter table app.homework_checks enable trigger user;
alter table app.lesson_sessions enable trigger user;
alter table app.attendance_submissions enable trigger user;
alter table app.homework_assignments enable trigger user;
vacuum analyze;
select relname as table, n_live_tup as rows,
       pg_size_pretty(pg_total_relation_size(relid)) as total_incl_indexes
  from pg_stat_user_tables
 where schemaname = 'app' and n_live_tup > 1000
 order by pg_total_relation_size(relid) desc;
select pg_size_pretty(pg_database_size(current_database())) as whole_database;
