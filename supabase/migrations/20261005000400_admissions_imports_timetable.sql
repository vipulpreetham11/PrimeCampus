-- =============================================================================
-- PrimeCampus V1 — 0400 Admissions (PRD §8), Imports (PRD IMPORT-01), Timetable (PRD §9)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Admission enquiries
-- -----------------------------------------------------------------------------
create table app.leads (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null,
  academic_year_id     uuid,
  parent_name          text not null check (length(btrim(parent_name)) between 1 and 200),
  phone                text not null check (phone ~ '^[0-9]{10}$'),   -- normalized 10-digit; never an identity key
  alt_phone            text check (alt_phone ~ '^[0-9]{10}$'),
  email                text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  child_name           text check (length(child_name) <= 200),
  child_dob            date,
  interested_class_id  uuid,
  source               text not null check (source in ('walk_in','website','referral','phone','other')),
  source_detail        text check (length(source_detail) <= 200),
  stage                text not null default 'new' check (stage in ('new','contacted','visited','converted','lost')),
  lost_reason          text check (length(lost_reason) <= 500),
  assigned_to          uuid references app.accounts(id),
  next_follow_up_on    date,
  notes                text check (length(notes) <= 4000),
  converted_student_id uuid,
  converted_at         timestamptz,
  created_by           uuid references app.accounts(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              integer not null default 1,
  unique (school_id, id),
  -- "Converted" requires a real connected student (PRD ADM-02)
  check ((stage = 'converted') = (converted_student_id is not null)),
  check ((converted_student_id is null) = (converted_at is null)),
  check (stage <> 'lost' or lost_reason is not null),
  foreign key (school_id, academic_year_id)     references app.academic_years (school_id, id),
  foreign key (school_id, interested_class_id)  references app.classes (school_id, id),
  foreign key (school_id, converted_student_id) references app.students (school_id, id)
);
create unique index leads_converted_student_uq on app.leads (converted_student_id) where converted_student_id is not null;
create index leads_followup_idx on app.leads (school_id, next_follow_up_on) where stage not in ('converted','lost');
create index leads_phone_idx on app.leads (school_id, phone);
create index leads_stage_idx on app.leads (school_id, stage, created_at desc);

-- Append-only contact history
create table app.lead_followups (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null,
  lead_id            uuid not null,
  contacted_at       timestamptz not null,
  channel            text not null check (channel in ('phone','walk_in','visit','whatsapp','email','other')),
  outcome            text not null check (outcome in ('reached','no_answer','callback_requested','visit_scheduled','visited','not_interested','other')),
  note               text check (length(note) <= 1000),
  next_follow_up_on  date,
  created_by         uuid not null references app.accounts(id),
  created_at         timestamptz not null default now(),
  unique (school_id, id),
  foreign key (school_id, lead_id) references app.leads (school_id, id)
);
create index lead_followups_lead_idx on app.lead_followups (lead_id, contacted_at desc);

-- -----------------------------------------------------------------------------
-- Spreadsheet imports. Source files are never stored; manifests + row results are.
-- -----------------------------------------------------------------------------
create table app.import_jobs (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null,
  academic_year_id    uuid,
  dataset             text not null check (dataset in ('classes_sections','staff','students_guardians','placements','opening_balances')),
  file_name           text check (length(file_name) <= 255),
  source_fingerprint  text not null check (length(source_fingerprint) between 16 and 128),
  mapping             jsonb not null default '{}',
  mapping_version     integer not null default 1,
  status              text not null default 'validating'
                        check (status in ('validating','ready','committing','completed','partially_completed','failed','cancelled')),
  total_rows          integer not null default 0 check (total_rows between 0 and 10000),
  committed_rows      integer not null default 0,
  rejected_rows       integer not null default 0,
  operation_id        uuid not null,
  created_by          uuid not null references app.accounts(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  unique (school_id, operation_id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id)
);

create table app.import_rows (
  id              bigint generated always as identity primary key,
  school_id       uuid not null,
  import_job_id   uuid not null,
  row_no          integer not null check (row_no > 0),
  source_key      text check (length(source_key) <= 120),
  action          text not null default 'create' check (action in ('create','update','skip')),
  status          text not null default 'draft' check (status in ('draft','removed','pending','committed','rejected')),
  payload         jsonb not null,
  errors          jsonb,
  result_entity_id uuid,
  expected_version integer,          -- for explicit updates of existing records
  chunk_no        integer,
  updated_at      timestamptz not null default now(),
  unique (import_job_id, row_no),
  check (pg_column_size(payload) <= 8192),
  foreign key (school_id, import_job_id) references app.import_jobs (school_id, id)
);
create index import_rows_status_idx on app.import_rows (import_job_id, status);

-- Survives cleanup of verbose staging rows: stops re-import duplicating people/debts.
create table app.import_source_keys (
  school_id      uuid not null references app.schools(id),
  dataset        text not null,
  source_key     text not null,
  entity_id      uuid not null,
  import_job_id  uuid not null,
  created_at     timestamptz not null default now(),
  primary key (school_id, dataset, source_key)
);

-- -----------------------------------------------------------------------------
-- Timetable: versioned weekly plan per section
-- -----------------------------------------------------------------------------
create table app.timetable_versions (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null,
  academic_year_id    uuid not null,
  section_id          uuid not null,
  period_schedule_id  uuid not null,
  effective_from      date not null,
  effective_to        date,          -- exclusive
  status              text not null default 'draft' check (status in ('draft','active','retired')),
  copied_from_id      uuid,
  created_by          uuid references app.accounts(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  check (effective_to is null or effective_to > effective_from),
  foreign key (school_id, section_id, academic_year_id) references app.sections (school_id, id, academic_year_id),
  foreign key (school_id, period_schedule_id) references app.period_schedules (school_id, id),
  constraint timetable_versions_no_overlap
    exclude using gist (section_id with =, daterange(effective_from, effective_to) with &&)
    where (status = 'active')
);

create table app.timetable_entries (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null,
  timetable_version_id  uuid not null,
  weekday               smallint not null check (weekday between 1 and 7),
  slot_ordinal          smallint not null check (slot_ordinal between 1 and 20),
  subject_id            uuid not null,
  staff_id              uuid,        -- null = visibly unassigned, not a holiday (PRD TIME-01)
  unique (school_id, id),
  unique (timetable_version_id, weekday, slot_ordinal),
  foreign key (school_id, timetable_version_id) references app.timetable_versions (school_id, id) on delete cascade,
  foreign key (school_id, subject_id) references app.subjects (school_id, id),
  foreign key (school_id, staff_id)   references app.staff (school_id, id)
);
create index timetable_entries_staff_idx on app.timetable_entries (staff_id) where staff_id is not null;

-- Actual dated lessons. Stable identity once attendance/diary/homework point at them.
-- bigint id: high-volume internal key (TRD §8) keeps attendance rows small.
create table app.lesson_sessions (
  id                  bigint generated always as identity primary key,
  school_id           uuid not null,
  academic_year_id    uuid not null,
  section_id          uuid not null,
  session_date        date not null,
  slot_ordinal        smallint not null check (slot_ordinal between 1 and 20),
  slot_label          text not null,
  start_time          time not null,
  end_time            time not null,
  subject_id          uuid not null,
  planned_staff_id    uuid,
  actual_staff_id     uuid,
  timetable_entry_id  uuid,
  source              text not null default 'timetable' check (source in ('timetable','override','extra')),
  status              text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  cancel_reason       text check (length(cancel_reason) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  unique (section_id, session_date, slot_ordinal),
  check (end_time > start_time),
  check ((status = 'cancelled') = (cancel_reason is not null)),
  foreign key (school_id, section_id, academic_year_id) references app.sections (school_id, id, academic_year_id),
  foreign key (school_id, subject_id)       references app.subjects (school_id, id),
  foreign key (school_id, planned_staff_id) references app.staff (school_id, id),
  foreign key (school_id, actual_staff_id)  references app.staff (school_id, id)
);
create index lesson_sessions_section_date on app.lesson_sessions (section_id, session_date);
create index lesson_sessions_staff_date on app.lesson_sessions (actual_staff_id, session_date) where status = 'scheduled';
create index lesson_sessions_school_date on app.lesson_sessions (school_id, session_date);

create table app.substitutions (
  id                        uuid primary key default gen_random_uuid(),
  school_id                 uuid not null,
  lesson_session_id         bigint not null,
  original_staff_id         uuid,
  substitute_staff_id       uuid not null,
  reason                    text check (length(reason) <= 500),
  conflict_override_reason  text check (length(conflict_override_reason) <= 500),
  status                    text not null default 'active' check (status in ('active','replaced','cancelled')),
  assigned_by               uuid not null references app.accounts(id),
  assigned_at               timestamptz not null default now(),
  ended_by                  uuid references app.accounts(id),
  ended_at                  timestamptz,
  unique (school_id, id),
  check ((status = 'active') = (ended_at is null)),
  foreign key (school_id, lesson_session_id)   references app.lesson_sessions (school_id, id),
  foreign key (school_id, original_staff_id)   references app.staff (school_id, id),
  foreign key (school_id, substitute_staff_id) references app.staff (school_id, id)
);
create unique index substitutions_one_active on app.substitutions (lesson_session_id) where status = 'active';
create index substitutions_staff_idx on app.substitutions (substitute_staff_id) where status = 'active';

do $$ declare t text; begin
  foreach t in array array['leads','import_jobs','timetable_versions','lesson_sessions'] loop
    execute format('create trigger %1$s_touch before update on app.%1$s for each row execute function app.tg_touch()', t);
  end loop;
  foreach t in array array['leads','lead_followups','lesson_sessions','substitutions','import_jobs'] loop
    execute format('create trigger %1$s_no_del before delete on app.%1$s for each row execute function app.tg_no_delete()', t);
  end loop;
end $$;
create trigger lead_followups_immutable before update on app.lead_followups
  for each row execute function app.tg_immutable();
