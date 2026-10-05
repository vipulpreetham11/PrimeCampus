-- =============================================================================
-- PrimeCampus V1 — 0700 Salary calculator snapshots (PRD SAL-01),
-- audit / auth history / telemetry (PRD §14, TRD §16), export manifests (TRD §15)
-- =============================================================================

-- payable = round(monthly_salary × (attended + paid_leave) / working)
-- Snapshots never recalculate; a correction is a new version that supersedes.
create table app.salary_calculations (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null,
  staff_id              uuid not null,
  month                 date not null check (extract(day from month) = 1),
  version_no            smallint not null default 1 check (version_no > 0),
  supersedes_id         uuid,
  status                text not null default 'final' check (status in ('final','superseded')),
  monthly_salary_paise  bigint not null check (monthly_salary_paise >= 0),
  working_days          numeric(5,2) not null check (working_days > 0),
  attended_days         numeric(5,2) not null check (attended_days >= 0),
  paid_leave_days       numeric(5,2) not null check (paid_leave_days >= 0),
  unpaid_days           numeric(5,2) not null check (unpaid_days >= 0),
  payable_paise         bigint not null check (payable_paise >= 0),
  discrepancies         jsonb not null default '[]',   -- unmarked days etc. shown for review
  overrides             jsonb not null default '{}',
  override_reason       text check (length(override_reason) <= 500),
  inputs                jsonb not null,                -- calendar/attendance/leave references used
  calculated_by         uuid not null references app.accounts(id),
  created_at            timestamptz not null default now(),
  unique (school_id, id),
  unique (staff_id, month, version_no),
  check (attended_days + paid_leave_days <= working_days),
  check (unpaid_days = working_days - attended_days - paid_leave_days),
  check (payable_paise = round(monthly_salary_paise * (attended_days + paid_leave_days) / working_days)),
  check (overrides = '{}'::jsonb or override_reason is not null),
  check ((version_no = 1) = (supersedes_id is null)),
  foreign key (school_id, staff_id)      references app.staff (school_id, id),
  foreign key (school_id, supersedes_id) references app.salary_calculations (school_id, id)
);
create unique index salary_calculations_one_final on app.salary_calculations (staff_id, month) where status = 'final';
create index salary_calculations_school_month on app.salary_calculations (school_id, month);

create or replace function app.tg_salary_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'final' or new.status <> 'superseded'
     or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'Saved salary calculations are immutable; save a corrected version' using errcode = 'P0001', hint = 'VALIDATION_ERROR';
  end if;
  return new;
end $$;
create trigger salary_calculations_guard before update on app.salary_calculations
  for each row execute function app.tg_salary_guard();
create trigger salary_calculations_no_del before delete on app.salary_calculations
  for each row execute function app.tg_no_delete();

-- -----------------------------------------------------------------------------
-- Trusted business audit. Written only by triggers / definer routines inside the
-- same transaction as the change. Operator-only reads. No automatic purge.
-- -----------------------------------------------------------------------------
create table private.audit_events (
  id                bigint generated always as identity primary key,
  occurred_at       timestamptz not null default now(),
  actor_id          uuid,                  -- null only for system jobs / migrations
  actor_role        text,
  via_operator      boolean not null default false,
  app_session_id    uuid,
  school_id         uuid,
  academic_year_id  uuid,
  action            text not null check (length(action) between 3 and 80),   -- e.g. 'fees.collection.posted'
  entity_type       text not null,
  entity_id         text,
  operation_id      uuid,
  detail            jsonb not null default '{}',
  check (pg_column_size(detail) <= 8192)
);
create index audit_events_school_time on private.audit_events (school_id, occurred_at desc);
create index audit_events_actor_time  on private.audit_events (actor_id, occurred_at desc);
create index audit_events_entity      on private.audit_events (entity_type, entity_id);

-- Login / logout / reset / provisioning history (13-month default retention)
create table private.auth_events (
  id               bigint generated always as identity primary key,
  occurred_at      timestamptz not null default now(),
  account_id       uuid,       -- null when a failed attempt has no verified identity
  event            text not null check (event in ('login','logout','session_revoked','password_changed','password_reset',
                                                   'account_provisioned','account_disabled','account_enabled',
                                                   'membership_granted','membership_disabled','context_selected','login_failed')),
  outcome          text not null default 'success' check (outcome in ('success','failure')),
  actor_id         uuid,       -- who performed it (admin/operator for resets etc.)
  app_session_id   uuid,
  auth_session_id  uuid,
  school_id        uuid,
  ip               inet,
  user_agent       text check (length(user_agent) <= 400),
  device_class     text,
  detail           jsonb not null default '{}',
  check (pg_column_size(detail) <= 2048)
);
create index auth_events_account_time on private.auth_events (account_id, occurred_at desc);
create index auth_events_time on private.auth_events (occurred_at desc);

-- Browser-reported, approximate (30-day default retention)
create table private.telemetry_events (
  id              bigint generated always as identity primary key,
  received_at     timestamptz not null default now(),
  occurred_at     timestamptz not null,
  account_id      uuid not null,
  app_session_id  uuid not null,
  school_id       uuid,
  event           text not null check (event in ('page_view','context_display','activity')),
  path            text check (length(path) <= 200),
  browser         text check (length(browser) <= 40),
  os              text check (length(os) <= 40),
  device_class    text check (device_class in ('desktop','mobile','tablet','unknown')),
  payload         jsonb not null default '{}',
  check (pg_column_size(payload) <= 2048)
);
create index telemetry_events_time on private.telemetry_events (received_at);
create index telemetry_events_account on private.telemetry_events (account_id, received_at desc);

-- Daily aggregates (13-month default retention)
create table private.usage_daily (
  day                 date not null,
  account_id          uuid not null,
  school_id           uuid not null,
  sessions            integer not null default 0,
  page_views          integer not null default 0,
  active_minutes_est  integer not null default 0,
  primary key (day, account_id, school_id)
);

create table private.retention_settings (
  key         text primary key check (key in ('telemetry_days','usage_daily_days','auth_events_days')),
  days        integer not null check (days between 7 and 3650),
  updated_by  uuid references app.accounts(id),
  updated_at  timestamptz not null default now()
);
insert into private.retention_settings (key, days) values
  ('telemetry_days', 30), ('usage_daily_days', 400), ('auth_events_days', 400);

create table private.export_jobs (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references app.schools(id),
  requested_by    uuid not null references app.accounts(id),
  kind            text not null check (kind in ('full_school','dataset','audit')),
  datasets        text[] not null,
  status          text not null default 'running' check (status in ('running','completed','failed','cancelled')),
  schema_version  text not null,
  window_start    timestamptz not null default now(),
  window_end      timestamptz,
  counts          jsonb not null default '{}',
  error           text,
  created_at      timestamptz not null default now()
);
