-- =============================================================================
-- PrimeCampus V1 — 0200 School & academic setup (PRD §6)
-- Convention: every school-owned table carries school_id and UNIQUE (school_id, id).
-- Children reference parents with composite (school_id, parent_id) foreign keys,
-- so a row can never point at another tenant's record (TRD §7.3).
-- =============================================================================

create table app.academic_years (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references app.schools(id),
  name        text not null check (length(btrim(name)) between 1 and 40),
  start_date  date not null,
  end_date    date not null,
  is_current  boolean not null default false,
  status      text not null default 'active' check (status in ('active','closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,
  unique (school_id, id),
  unique (school_id, name),
  check (end_date > start_date),
  check (end_date - start_date <= 550),
  constraint academic_years_no_overlap
    exclude using gist (school_id with =, daterange(start_date, end_date, '[]') with &&)
);
-- at most one current default year per school (PRD SETUP-03)
create unique index academic_years_one_current on app.academic_years (school_id) where is_current;

create table app.classes (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references app.schools(id),
  name        text not null check (length(btrim(name)) between 1 and 40),
  sort_order  smallint not null,
  status      text not null default 'active' check (status in ('active','retired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,
  unique (school_id, id)
);
create unique index classes_name_uq on app.classes (school_id, lower(name));

create table app.sections (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  class_id          uuid not null,
  name              text not null check (length(btrim(name)) between 1 and 20),
  capacity          smallint check (capacity between 1 and 200),
  sort_order        smallint not null default 0,
  status            text not null default 'active' check (status in ('active','retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  unique (school_id, id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, class_id)         references app.classes (school_id, id)
);
create unique index sections_name_uq on app.sections (school_id, academic_year_id, class_id, lower(name));

create table app.subjects (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references app.schools(id),
  name        text not null check (length(btrim(name)) between 1 and 80),
  code        text not null check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  status      text not null default 'active' check (status in ('active','retired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,
  unique (school_id, id)
);
create unique index subjects_code_uq on app.subjects (school_id, upper(code));
create unique index subjects_name_uq on app.subjects (school_id, lower(name));

-- Subjects offered to a class in a given year (no hard-coded national list).
create table app.class_subjects (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  class_id          uuid not null,
  subject_id        uuid not null,
  is_optional       boolean not null default false,
  sort_order        smallint not null default 0,
  status            text not null default 'active' check (status in ('active','retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  unique (school_id, id),
  unique (academic_year_id, class_id, subject_id),
  foreign key (school_id, academic_year_id) references app.academic_years (school_id, id),
  foreign key (school_id, class_id)         references app.classes (school_id, id),
  foreign key (school_id, subject_id)       references app.subjects (school_id, id)
);

-- -----------------------------------------------------------------------------
-- Operating schedule: versioned bell schedules with ordered periods/breaks
-- -----------------------------------------------------------------------------
create table app.period_schedules (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references app.schools(id),
  name            text not null check (length(btrim(name)) between 1 and 60),
  kind            text not null default 'regular' check (kind in ('regular','half_day','special')),
  day_start       time not null,
  day_end         time not null,
  effective_from  date not null,
  effective_to    date,                     -- exclusive; null = open
  status          text not null default 'active' check (status in ('active','retired')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  unique (school_id, id),
  check (day_end > day_start),
  check (effective_to is null or effective_to > effective_from)
);
-- only one active *regular* schedule per school at a time
alter table app.period_schedules add constraint period_schedules_regular_no_overlap
  exclude using gist (school_id with =, daterange(effective_from, effective_to) with &&)
  where (kind = 'regular' and status = 'active');

create table app.schedule_slots (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null,
  period_schedule_id  uuid not null,
  ordinal             smallint not null check (ordinal between 1 and 20),
  label               text not null check (length(btrim(label)) between 1 and 40),
  kind                text not null check (kind in ('period','break')),
  start_time          time not null,
  end_time            time not null,
  unique (school_id, id),
  unique (period_schedule_id, ordinal),
  check (end_time > start_time),
  foreign key (school_id, period_schedule_id) references app.period_schedules (school_id, id),
  constraint schedule_slots_no_overlap exclude using gist (
    period_schedule_id with =,
    tsrange(date '2000-01-01' + start_time, date '2000-01-01' + end_time) with &&)
);

-- -----------------------------------------------------------------------------
-- Staff groups (needed by staff calendars; staff themselves arrive in 0300)
-- -----------------------------------------------------------------------------
create table app.staff_groups (
  id                            uuid primary key default gen_random_uuid(),
  school_id                     uuid not null references app.schools(id),
  name                          text not null check (length(btrim(name)) between 1 and 80),
  status                        text not null default 'active' check (status in ('active','retired')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  version                       integer not null default 1,
  unique (school_id, id)
);
create unique index staff_groups_name_uq on app.staff_groups (school_id, lower(name));

-- -----------------------------------------------------------------------------
-- Calendars (PRD SETUP-04, TRD §9)
-- Resolution precedence per audience:
--   dated override (group) > dated override (audience default)
--   > weekday pattern (group) > weekday pattern (audience default) > not a working day
-- Student and staff calendars are independent rows (audience).
-- -----------------------------------------------------------------------------
create table app.calendar_patterns (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null,
  academic_year_id    uuid not null,
  audience            text not null check (audience in ('student','staff')),
  staff_group_id      uuid,
  weekday             smallint not null check (weekday between 1 and 7),  -- ISO: 1=Mon .. 7=Sun
  day_type            text not null check (day_type in ('working','half_day','weekly_off')),
  period_schedule_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  constraint calendar_patterns_slot_uq unique nulls not distinct (academic_year_id, audience, staff_group_id, weekday),
  check (audience = 'staff' or staff_group_id is null),
  check (audience = 'staff' or day_type <> 'half_day' or period_schedule_id is not null),
  foreign key (school_id, academic_year_id)   references app.academic_years (school_id, id),
  foreign key (school_id, staff_group_id)     references app.staff_groups (school_id, id),
  foreign key (school_id, period_schedule_id) references app.period_schedules (school_id, id)
);

create table app.calendar_days (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null,
  academic_year_id    uuid not null,
  audience            text not null check (audience in ('student','staff')),
  staff_group_id      uuid,
  cal_date            date not null,
  day_type            text not null check (day_type in ('working','half_day','holiday','weekly_off')),
  period_schedule_id  uuid,       -- which bell schedule applies (required for student half-days)
  label               text check (length(label) <= 120),
  reason              text check (length(reason) <= 500),
  is_exam_day         boolean not null default false,   -- label only; does not cancel attendance
  is_special          boolean not null default false,
  created_by          uuid references app.accounts(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  unique (school_id, id),
  constraint calendar_days_date_uq unique nulls not distinct (school_id, audience, staff_group_id, cal_date),
  check (audience = 'staff' or staff_group_id is null),
  check (audience = 'staff' or day_type <> 'half_day' or period_schedule_id is not null),
  foreign key (school_id, academic_year_id)   references app.academic_years (school_id, id),
  foreign key (school_id, staff_group_id)     references app.staff_groups (school_id, id),
  foreign key (school_id, period_schedule_id) references app.period_schedules (school_id, id)
);
create index calendar_days_lookup on app.calendar_days (school_id, audience, cal_date);

-- Dates outside the selected year must not become attendance days (PRD SETUP-04)
create or replace function app.tg_calendar_day_in_year()
returns trigger language plpgsql set search_path = '' as $$
declare v_start date; v_end date;
begin
  select start_date, end_date into v_start, v_end
    from app.academic_years where id = new.academic_year_id and school_id = new.school_id;
  if new.cal_date < v_start or new.cal_date > v_end then
    raise exception 'Date % is outside academic year % – %', new.cal_date, v_start, v_end
      using errcode = 'P0001', hint = 'VALIDATION_ERROR';
  end if;
  return new;
end $$;
create trigger calendar_days_in_year before insert or update on app.calendar_days
  for each row execute function app.tg_calendar_day_in_year();

-- Student attendance mode with effective boundary (PRD ATT-01)
create table app.attendance_modes (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references app.schools(id),
  mode            text not null check (mode in ('daily','period')),
  effective_from  date not null,
  created_by      uuid references app.accounts(id),
  created_at      timestamptz not null default now(),
  unique (school_id, effective_from)
);

do $$ declare t text; begin
  foreach t in array array['academic_years','classes','sections','subjects','class_subjects',
                           'period_schedules','staff_groups','calendar_patterns','calendar_days'] loop
    execute format('create trigger %1$s_touch before update on app.%1$s for each row execute function app.tg_touch()', t);
  end loop;
  foreach t in array array['academic_years','classes','sections','subjects','class_subjects','period_schedules',
                           'staff_groups','attendance_modes'] loop
    execute format('create trigger %1$s_no_del before delete on app.%1$s for each row execute function app.tg_no_delete()', t);
  end loop;
end $$;
