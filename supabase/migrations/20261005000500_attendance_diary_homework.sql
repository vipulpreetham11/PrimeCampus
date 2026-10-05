-- =============================================================================
-- PrimeCampus V1 — 0500 Attendance (PRD §10, §13), Diary & Homework (PRD §11)
--
-- Founder decision (5 Oct 2026): student period attendance = one row per
-- student per lesson (replaces TRD TD-05 compact day container).
-- Rows are kept narrow: bigint lesson id, 1-char status, actor/time live on the
-- shared submission header instead of on every mark.
-- No row = Unmarked. A row never means "absent" unless status = 'A'.
-- =============================================================================

create table app.attendance_submissions (
  id                 bigint generated always as identity primary key,
  school_id          uuid not null references app.schools(id),
  kind               text not null check (kind in ('student_daily','student_period','staff')),
  attendance_date    date not null,
  section_id         uuid,
  lesson_session_id  bigint,
  actor_id           uuid not null references app.accounts(id),
  actor_role         text not null,
  operation_id       uuid not null,
  marked_count       integer not null default 0,
  changed_count      integer not null default 0,   -- previously-marked values that changed
  created_at         timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, operation_id),
  check (kind <> 'student_daily'  or (section_id is not null and lesson_session_id is null)),
  check (kind <> 'student_period' or lesson_session_id is not null),
  check (kind <> 'staff'          or (section_id is null and lesson_session_id is null)),
  foreign key (school_id, lesson_session_id) references app.lesson_sessions (school_id, id)
);
create index attendance_submissions_date on app.attendance_submissions (school_id, attendance_date);

-- Daily mode: Present/Late = 1, Half-day = 0.5, Absent = 0
create table app.student_daily_attendance (
  student_id       uuid not null,
  attendance_date  date not null,
  school_id        uuid not null,
  section_id       uuid not null,
  status           char(1) not null check (status in ('P','L','H','A')),
  submission_id    bigint not null,
  version          smallint not null default 1,
  primary key (student_id, attendance_date),
  foreign key (school_id, student_id)    references app.students (school_id, id),
  foreign key (school_id, section_id)    references app.sections (school_id, id),
  foreign key (school_id, submission_id) references app.attendance_submissions (school_id, id)
);
create index student_daily_att_section_date on app.student_daily_attendance (section_id, attendance_date);

-- Period mode: Present/Late = 1, Absent = 0. No period half-day code.
create table app.student_period_attendance (
  lesson_session_id  bigint not null,
  student_id         uuid not null,
  school_id          uuid not null,
  attendance_date    date not null,     -- copy of the session date for student/date range reads
  status             char(1) not null check (status in ('P','L','A')),
  submission_id      bigint not null,
  version            smallint not null default 1,
  primary key (lesson_session_id, student_id),
  foreign key (school_id, lesson_session_id) references app.lesson_sessions (school_id, id),
  foreign key (school_id, student_id)        references app.students (school_id, id),
  foreign key (school_id, submission_id)     references app.attendance_submissions (school_id, id)
);
create index student_period_att_student_date on app.student_period_attendance (student_id, attendance_date);

-- Staff daily marks (Admin only). Half-day = 0.5.
create table app.staff_attendance (
  staff_id         uuid not null,
  attendance_date  date not null,
  school_id        uuid not null,
  status           char(1) not null check (status in ('P','L','H','A')),
  submission_id    bigint not null,
  version          smallint not null default 1,
  primary key (staff_id, attendance_date),
  foreign key (school_id, staff_id)      references app.staff (school_id, id),
  foreign key (school_id, submission_id) references app.attendance_submissions (school_id, id)
);
create index staff_attendance_school_date on app.staff_attendance (school_id, attendance_date);

-- Compact correction trail: written only when a previously marked value changes.
create table app.attendance_changes (
  id                 bigint generated always as identity primary key,
  school_id          uuid not null references app.schools(id),
  kind               text not null check (kind in ('student_daily','student_period','staff')),
  person_id          uuid not null,          -- student_id or staff_id
  attendance_date    date not null,
  lesson_session_id  bigint,
  old_status         char(1),
  new_status         char(1) not null,
  submission_id      bigint not null,
  foreign key (school_id, submission_id) references app.attendance_submissions (school_id, id)
);
create index attendance_changes_person on app.attendance_changes (person_id, attendance_date);

-- Approved paid leave used (calculator input; no leave-request portal in V1)
create table app.staff_paid_leave (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null,
  staff_id      uuid not null,
  leave_date    date not null,
  day_fraction  numeric(3,2) not null check (day_fraction in (0.5, 1.0)),
  reason        text check (length(reason) <= 500),
  status        text not null default 'active' check (status in ('active','cancelled')),
  recorded_by   uuid not null references app.accounts(id),
  created_at    timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, staff_id) references app.staff (school_id, id)
);
create unique index staff_paid_leave_one_per_day on app.staff_paid_leave (staff_id, leave_date) where status = 'active';

-- -----------------------------------------------------------------------------
-- Diary: one shared note per actual lesson (not per student)
-- -----------------------------------------------------------------------------
create table app.diary_entries (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null,
  lesson_session_id  bigint not null,
  body               text not null check (length(btrim(body)) between 1 and 4000),
  recorded_by        uuid not null references app.accounts(id),
  recorded_by_staff  uuid,
  created_at         timestamptz not null default now(),   -- entry time (distinct from lesson date)
  updated_by         uuid references app.accounts(id),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1,
  unique (school_id, id),
  unique (lesson_session_id),
  foreign key (school_id, lesson_session_id) references app.lesson_sessions (school_id, id),
  foreign key (school_id, recorded_by_staff) references app.staff (school_id, id)
);

-- -----------------------------------------------------------------------------
-- Homework: class-level assignment + per-student check records
-- -----------------------------------------------------------------------------
create table app.homework_assignments (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null,
  academic_year_id   uuid not null,
  section_id         uuid not null,
  subject_id         uuid not null,
  lesson_session_id  bigint,
  assigned_by_staff  uuid,
  assigned_on        date not null,
  due_on             date not null,
  description        text not null check (length(btrim(description)) between 1 and 4000),
  status             text not null default 'active' check (status in ('active','cancelled')),
  created_by         uuid not null references app.accounts(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1,
  unique (school_id, id),
  check (due_on >= assigned_on),
  foreign key (school_id, section_id, academic_year_id) references app.sections (school_id, id, academic_year_id),
  foreign key (school_id, subject_id)        references app.subjects (school_id, id),
  foreign key (school_id, lesson_session_id) references app.lesson_sessions (school_id, id),
  foreign key (school_id, assigned_by_staff) references app.staff (school_id, id)
);
create index homework_section_due on app.homework_assignments (section_id, due_on);
create index homework_lesson_idx on app.homework_assignments (lesson_session_id) where lesson_session_id is not null;

-- No row = Unchecked (never "not completed").
create table app.homework_checks (
  id               bigint generated always as identity primary key,
  school_id        uuid not null,
  assignment_id    uuid not null,
  student_id       uuid not null,
  completion       text not null check (completion in ('completed','not_completed')),
  correction       text not null default 'none' check (correction in ('none','required','done')),
  observed_on      date not null,          -- when the teacher checked in class
  completed_on     date,                   -- known completion date, only if recorded
  comment          text check (length(comment) <= 1000),
  checked_by       uuid not null references app.accounts(id),
  entered_at       timestamptz not null default now(),   -- when it was typed in
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,
  unique (assignment_id, student_id),
  check (completed_on is null or completion = 'completed'),
  foreign key (school_id, assignment_id) references app.homework_assignments (school_id, id),
  foreign key (school_id, student_id)    references app.students (school_id, id)
);
create index homework_checks_student on app.homework_checks (student_id);

create table app.homework_check_changes (
  id              bigint generated always as identity primary key,
  school_id       uuid not null references app.schools(id),
  check_id        bigint not null references app.homework_checks(id),
  old_completion  text,
  new_completion  text not null,
  old_correction  text,
  new_correction  text not null,
  observed_on     date not null,
  changed_by      uuid not null references app.accounts(id),
  changed_at      timestamptz not null default now()
);
create index homework_check_changes_check on app.homework_check_changes (check_id);

do $$ declare t text; begin
  foreach t in array array['diary_entries','homework_assignments','homework_checks'] loop
    execute format('create trigger %1$s_touch before update on app.%1$s for each row execute function app.tg_touch()', t);
  end loop;
  foreach t in array array['attendance_submissions','student_daily_attendance','student_period_attendance',
                           'staff_attendance','attendance_changes','staff_paid_leave','diary_entries',
                           'homework_assignments','homework_checks','homework_check_changes'] loop
    execute format('create trigger %1$s_no_del before delete on app.%1$s for each row execute function app.tg_no_delete()', t);
  end loop;
end $$;
create trigger attendance_changes_immutable before update on app.attendance_changes for each row execute function app.tg_immutable();
create trigger homework_check_changes_immutable before update on app.homework_check_changes for each row execute function app.tg_immutable();
