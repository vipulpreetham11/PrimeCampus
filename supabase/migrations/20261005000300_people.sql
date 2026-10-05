-- =============================================================================
-- PrimeCampus V1 — 0300 Students, guardians, enrollment/placement, staff (PRD §7, §13)
-- Student profile columns follow the UDISE+ 4.1 General Profile as a reference
-- layout. No government sync; reporting-sensitive identifiers live in a separate
-- Admin-only table (PRD SIS-01, TRD §7.2).
-- =============================================================================

alter table app.sections add constraint sections_school_id_year_uq unique (school_id, id, academic_year_id);

create table app.students (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null references app.schools(id),
  admission_no        text not null check (length(btrim(admission_no)) between 1 and 40),
  full_name           text not null check (length(btrim(full_name)) between 1 and 200),   -- UDISE 4.1.1
  gender              text not null check (gender in ('male','female','transgender')),    -- 4.1.2
  date_of_birth       date not null check (date_of_birth > date '1990-01-01'),           -- 4.1.3
  mother_name         text check (length(mother_name) <= 200),                            -- 4.1.4
  father_name         text check (length(father_name) <= 200),                            -- 4.1.5
  guardian_name       text check (length(guardian_name) <= 200),                          -- 4.1.6
  address_line        text check (length(address_line) <= 500),                           -- 4.1.9a
  pincode             text check (pincode ~ '^[0-9]{6}$'),                                -- 4.1.9b
  mobile              text check (mobile ~ '^[0-9]{10}$'),                                -- 4.1.10a
  alt_mobile          text check (alt_mobile ~ '^[0-9]{10}$'),                            -- 4.1.10b
  email               text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),                -- 4.1.11
  mother_tongue       text check (length(mother_tongue) <= 60),                           -- 4.1.12
  is_indian_national  boolean not null default true,                                      -- 4.1.18
  nationality         text check (length(nationality) <= 60),                             -- 4.1.18a
  blood_group         text check (blood_group in ('A+','A-','B+','B-','AB+','AB-','O+','O-')), -- 4.1.20
  admission_date      date not null,
  previous_school     text check (length(previous_school) <= 200),
  previous_class      text check (length(previous_class) <= 40),
  account_id          uuid references app.accounts(id),        -- optional student login
  status              text not null default 'active' check (status in ('active','inactive','archived')),
  created_by          uuid references app.accounts(id),
  created_at          timestamptz not null default now(),
  updated_by          uuid references app.accounts(id),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  check (is_indian_national or nationality is not null)
);
create unique index students_admission_no_uq on app.students (school_id, upper(admission_no));
create unique index students_account_uq on app.students (school_id, account_id) where account_id is not null;
create index students_name_search on app.students (school_id, lower(full_name) text_pattern_ops);

-- Reporting-sensitive fields: Admin / Operator only. Never in teacher/parent DTOs.
create table app.student_sensitive (
  student_id               uuid primary key,
  school_id                uuid not null,
  name_as_per_aadhaar      text check (length(name_as_per_aadhaar) <= 200),   -- 4.1.8
  aadhaar_number           text check (aadhaar_number ~ '^[0-9]{12}$'),       -- 4.1.7
  student_national_code    text check (length(student_national_code) <= 30),  -- PEN, entered not generated
  apaar_id                 text check (length(apaar_id) <= 30),               -- entered not generated
  social_category          text check (social_category in ('general','sc','st','obc')),               -- 4.1.13
  minority_group           text check (minority_group in ('muslim','christian','sikh','buddhist','parsi','jain','not_applicable')), -- 4.1.14
  is_bpl                   boolean,                                           -- 4.1.15
  is_aay                   boolean,                                           -- 4.1.15a
  is_ews_disadvantaged     boolean,                                           -- 4.1.16
  is_cwsn                  boolean,                                           -- 4.1.17
  impairment_type          text check (length(impairment_type) <= 60),        -- 4.1.17a
  has_disability_cert      boolean,                                           -- 4.1.17b
  disability_percent       smallint check (disability_percent between 0 and 100),
  is_out_of_school_child   boolean,                                           -- 4.1.19
  mainstreamed_in          text check (mainstreamed_in in ('current_year','earlier_year')), -- 4.1.19a
  family_annual_income_paise bigint check (family_annual_income_paise >= 0),
  updated_by               uuid references app.accounts(id),
  updated_at               timestamptz not null default now(),
  version                  integer not null default 1,
  foreign key (school_id, student_id) references app.students (school_id, id),
  check (is_cwsn is true or (impairment_type is null and disability_percent is null)),
  check (is_bpl is true or is_aay is not true),
  check (is_out_of_school_child is true or mainstreamed_in is null)
);
create unique index student_sensitive_aadhaar_uq on app.student_sensitive (school_id, aadhaar_number)
  where aadhaar_number is not null;

-- Guardians are separate people; shared phone numbers never merge records.
create table app.guardians (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references app.schools(id),
  full_name     text not null check (length(btrim(full_name)) between 1 and 200),
  phone         text check (phone ~ '^[0-9]{10}$'),
  alt_phone     text check (alt_phone ~ '^[0-9]{10}$'),
  email         text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  occupation    text check (length(occupation) <= 100),
  address_line  text check (length(address_line) <= 500),
  account_id    uuid references app.accounts(id),        -- parent login, optional
  status        text not null default 'active' check (status in ('active','inactive')),
  created_by    uuid references app.accounts(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1,
  unique (school_id, id)
);
create index guardians_phone_idx on app.guardians (school_id, phone);
create index guardians_account_idx on app.guardians (account_id) where account_id is not null;

create table app.student_guardians (
  school_id      uuid not null,
  student_id     uuid not null,
  guardian_id    uuid not null,
  relationship   text not null check (relationship in ('mother','father','guardian','grandparent','sibling','other')),
  is_primary     boolean not null default false,
  portal_access  boolean not null default true,      -- may see this child in Parent context
  created_at     timestamptz not null default now(),
  primary key (student_id, guardian_id),
  foreign key (school_id, student_id)  references app.students (school_id, id),
  foreign key (school_id, guardian_id) references app.guardians (school_id, id)
);
create unique index student_guardians_one_primary on app.student_guardians (student_id) where is_primary;
create index student_guardians_guardian_idx on app.student_guardians (guardian_id);

-- -----------------------------------------------------------------------------
-- Enrollment (student ↔ school year) and dated placement (section membership)
-- -----------------------------------------------------------------------------
create table app.enrollments (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  student_id        uuid not null,
  joined_on         date not null,     -- attendance and fee eligibility start here
  left_on           date,
  status            text not null default 'active' check (status in ('active','inactive')),
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  unique (school_id, id),
  unique (school_id, id, student_id, academic_year_id),
  unique (student_id, academic_year_id),
  check (left_on is null or left_on >= joined_on),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, student_id)       references app.students (school_id, id)
);
create index enrollments_year_idx on app.enrollments (school_id, academic_year_id) where status = 'active';

create table app.placement_batches (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references app.schools(id),
  operation_id    uuid not null,
  effective_from  date not null,
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  student_count   integer not null check (student_count > 0),
  created_by      uuid not null references app.accounts(id),
  created_at      timestamptz not null default now(),
  unique (school_id, id),
  unique (school_id, operation_id)
);

create table app.placements (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  enrollment_id     uuid not null,
  student_id        uuid not null,
  section_id        uuid not null,
  roll_no           text check (roll_no ~ '^[A-Za-z0-9/-]{1,12}$'),
  effective_from    date not null,
  effective_to      date,             -- exclusive; null = open-ended
  reason            text check (length(reason) <= 500),
  batch_id          uuid,
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  unique (school_id, id),
  check (effective_to is null or effective_to > effective_from),
  foreign key (school_id, enrollment_id, student_id, academic_year_id)
    references app.enrollments (school_id, id, student_id, academic_year_id),
  foreign key (school_id, section_id, academic_year_id)
    references app.sections (school_id, id, academic_year_id),
  foreign key (school_id, batch_id) references app.placement_batches (school_id, id),
  constraint placements_no_overlap
    exclude using gist (student_id with =, daterange(effective_from, effective_to) with &&),
  constraint placements_roll_unique
    exclude using gist (section_id with =, roll_no with =, daterange(effective_from, effective_to) with &&)
    where (roll_no is not null)
);
create index placements_section_idx on app.placements (section_id, effective_from);
create index placements_student_idx on app.placements (student_id, effective_from);

-- Only the closing date (effective_to) of a placement may change; history is otherwise fixed.
create or replace function app.tg_placement_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.student_id, new.section_id, new.enrollment_id, new.effective_from, new.school_id, new.academic_year_id)
     is distinct from
     (old.student_id, old.section_id, old.enrollment_id, old.effective_from, old.school_id, old.academic_year_id) then
    raise exception 'Placement history is fixed; close it and create a new placement instead'
      using errcode = 'P0001', hint = 'VALIDATION_ERROR';
  end if;
  return new;
end $$;
create trigger placements_guard before update on app.placements
  for each row execute function app.tg_placement_guard();

alter table private.app_sessions
  add constraint app_sessions_student_fk foreign key (student_id) references app.students(id);

-- -----------------------------------------------------------------------------
-- Staff (a teacher is a staff member; login is optional)
-- -----------------------------------------------------------------------------
create table app.staff (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null,
  employee_no     text not null check (length(btrim(employee_no)) between 1 and 40),
  full_name       text not null check (length(btrim(full_name)) between 1 and 200),
  gender          text check (gender in ('male','female','transgender')),
  phone           text check (phone ~ '^[0-9]{10}$'),
  email           text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  staff_group_id  uuid not null,
  designation     text check (length(designation) <= 80),
  is_teaching     boolean not null default false,
  joined_on       date not null,
  left_on         date,
  account_id      uuid references app.accounts(id),
  status          text not null default 'active' check (status in ('active','inactive')),
  created_by      uuid references app.accounts(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  unique (school_id, id),
  check (left_on is null or left_on >= joined_on),
  foreign key (school_id, staff_group_id) references app.staff_groups (school_id, id)
);
create unique index staff_employee_no_uq on app.staff (school_id, upper(employee_no));
create unique index staff_account_uq on app.staff (school_id, account_id) where account_id is not null;
create index staff_group_idx on app.staff (school_id, staff_group_id) where status = 'active';

-- Confidential: Admin / Owner / Operator only (PRD §13, TRD §13)
create table app.staff_salary_rates (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null,
  staff_id              uuid not null,
  monthly_salary_paise  bigint not null check (monthly_salary_paise between 0 and 100000000000),
  effective_from        date not null,
  reason                text check (length(reason) <= 500),
  created_by            uuid references app.accounts(id),
  created_at            timestamptz not null default now(),
  unique (school_id, id),
  unique (staff_id, effective_from),
  foreign key (school_id, staff_id) references app.staff (school_id, id)
);

-- Group salary default used to prefill new staff; employees keep their own rate.
create table app.staff_group_salary_defaults (
  staff_group_id        uuid primary key,
  school_id             uuid not null,
  monthly_salary_paise  bigint not null check (monthly_salary_paise between 0 and 100000000000),
  updated_by            uuid references app.accounts(id),
  updated_at            timestamptz not null default now(),
  foreign key (school_id, staff_group_id) references app.staff_groups (school_id, id)
);

create table app.staff_bank_accounts (
  staff_id             uuid primary key,
  school_id            uuid not null,
  account_holder_name  text not null check (length(btrim(account_holder_name)) between 1 and 200),
  account_number       text not null check (account_number ~ '^[0-9]{6,20}$'),
  ifsc                 text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name            text check (length(bank_name) <= 120),
  updated_by           uuid references app.accounts(id),
  updated_at           timestamptz not null default now(),
  version              integer not null default 1,
  foreign key (school_id, staff_id) references app.staff (school_id, id)
);

-- Teaching responsibility: subject teaching or class-teacher duty, effective-dated.
create table app.teaching_assignments (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  section_id        uuid not null,
  staff_id          uuid not null,
  kind              text not null check (kind in ('subject','class_teacher')),
  subject_id        uuid,
  effective_from    date not null,
  effective_to      date,          -- exclusive
  created_by        uuid references app.accounts(id),
  created_at        timestamptz not null default now(),
  unique (school_id, id),
  check ((kind = 'subject') = (subject_id is not null)),
  check (effective_to is null or effective_to > effective_from),
  foreign key (school_id, section_id, academic_year_id) references app.sections (school_id, id, academic_year_id),
  foreign key (school_id, staff_id)   references app.staff (school_id, id),
  foreign key (school_id, subject_id) references app.subjects (school_id, id),
  constraint one_class_teacher_per_section
    exclude using gist (section_id with =, daterange(effective_from, effective_to) with &&)
    where (kind = 'class_teacher'),
  constraint no_duplicate_subject_assignment
    exclude using gist (section_id with =, subject_id with =, staff_id with =, daterange(effective_from, effective_to) with &&)
    where (kind = 'subject')
);
create index teaching_assignments_staff_idx on app.teaching_assignments (staff_id, effective_from);
create index teaching_assignments_section_idx on app.teaching_assignments (section_id);

do $$ declare t text; begin
  foreach t in array array['students','student_sensitive','guardians','enrollments','staff','staff_bank_accounts'] loop
    execute format('create trigger %1$s_touch before update on app.%1$s for each row execute function app.tg_touch()', t);
  end loop;
  foreach t in array array['students','student_sensitive','guardians','enrollments','placements','placement_batches',
                           'staff','staff_salary_rates','teaching_assignments'] loop
    execute format('create trigger %1$s_no_del before delete on app.%1$s for each row execute function app.tg_no_delete()', t);
  end loop;
end $$;
