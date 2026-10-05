-- =============================================================================
-- PrimeCampus V1 — 0100 Foundation
-- Schemas, extensions, shared trigger functions, platform + identity tables.
--
-- Schema layout (TRD §4):
--   app      core school data. NOT exposed to the Data API. RLS on every table.
--   private  sessions, security helpers, audit, idempotency. NOT exposed.
--   public   thin RPC entry points only (exposed by Supabase by default).
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

create schema if not exists app;
create schema if not exists private;

revoke all on schema app     from public;
revoke all on schema private from public;
grant usage on schema app     to authenticated, service_role;
grant usage on schema private to authenticated, service_role;

-- Supabase adds per-schema grants to anon; remove them here. The built-in PUBLIC
-- EXECUTE default cannot be removed per schema, so 1400_lockdown_grants revokes it.
alter default privileges in schema app     revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema public  revoke execute on functions from anon;

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at + optimistic-concurrency version.
-- -----------------------------------------------------------------------------
create or replace function app.tg_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

-- Block hard DELETE on history-bearing tables (retire with status instead).
create or replace function app.tg_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Rows in %.% cannot be deleted; retire or reverse them instead', tg_table_schema, tg_table_name
    using errcode = 'P0001', hint = 'VALIDATION_ERROR';
end;
$$;

-- Block UPDATE on immutable ledger rows.
create or replace function app.tg_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Rows in %.% are immutable', tg_table_schema, tg_table_name
    using errcode = 'P0001', hint = 'VALIDATION_ERROR';
end;
$$;

-- =============================================================================
-- Platform hierarchy
-- =============================================================================
create table app.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 200),
  code        text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  status      text not null default 'active' check (status in ('active','suspended','closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1
);

create table app.schools (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references app.organizations(id),
  name             text not null check (length(btrim(name)) between 1 and 200),
  -- short code; also used as the username prefix when provisioning (TRD §6.1)
  code             text not null unique check (code ~ '^[a-z0-9]{2,12}$'),
  udise_code       text check (udise_code ~ '^[0-9]{11}$'),
  board            text,
  affiliation_no   text,
  phone            text check (phone ~ '^[0-9+ -]{6,20}$'),
  email            text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_line     text,
  city             text,
  district         text,
  state            text not null default 'Telangana',
  pincode          text check (pincode ~ '^[0-9]{6}$'),
  logo_url         text,  -- external URL only; V1 stores no binaries
  timezone         text not null default 'Asia/Kolkata',
  status           text not null default 'active' check (status in ('active','suspended','closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1
);
create index schools_org_idx on app.schools (organization_id);

-- =============================================================================
-- Identity
-- One global account per Supabase Auth user. Login is a school-issued username
-- mapped by the browser to <username>@login.<owned-domain> (TRD §6.1).
-- =============================================================================
create table app.accounts (
  id                    uuid primary key references auth.users(id) on delete restrict,
  username              text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,62}$'),
  display_name          text not null check (length(btrim(display_name)) between 1 and 200),
  status                text not null default 'pending' check (status in ('pending','active','disabled')),
  -- server-owned; cleared only after a verified password change (TRD §6.3)
  must_change_password  boolean not null default true,
  last_seen_at          timestamptz,
  created_by            uuid references app.accounts(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1
);

create table app.memberships (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references app.accounts(id),
  school_id        uuid not null references app.schools(id),
  role             text not null check (role in ('owner','admin','principal','accountant','teacher','parent','student')),
  status           text not null default 'active' check (status in ('active','disabled')),
  -- PRD ADM-02: admissions duty is a scoped capability, not a role
  admissions_duty  boolean not null default false,
  granted_by       uuid references app.accounts(id),
  disabled_at      timestamptz,
  disabled_by      uuid references app.accounts(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,
  unique (account_id, school_id, role),
  unique (school_id, id),
  check (not admissions_duty or role in ('admin','principal','accountant','teacher')),
  check ((status = 'disabled') = (disabled_at is not null))
);
create index memberships_school_role_idx on app.memberships (school_id, role) where status = 'active';

create table private.platform_operators (
  account_id  uuid primary key references app.accounts(id),
  granted_by  uuid references app.accounts(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- Server-held application session + active context (TRD §7.1).
-- Keyed by the Supabase JWT session_id claim.
create table private.app_sessions (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references app.accounts(id),
  auth_session_id     uuid not null unique,
  membership_id       uuid references app.memberships(id),
  operator_school_id  uuid references app.schools(id),   -- set only for Operator support context
  student_id          uuid,                              -- selected child / own student record (FK added in 0300)
  context_revision    integer not null default 0,
  ip                  inet,
  user_agent          text check (length(user_agent) <= 400),
  device_class        text check (device_class in ('desktop','mobile','tablet','unknown')),
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  ended_at            timestamptz,
  end_reason          text check (end_reason in ('logout','revoked','password_reset','account_disabled','expired')),
  check (membership_id is null or operator_school_id is null)
);
create index app_sessions_account_idx on private.app_sessions (account_id) where ended_at is null;

-- Resumable account provisioning (TRD §6.2). Auth + DB are separate systems.
create table private.provisioning_operations (
  operation_id      uuid primary key,
  requested_by      uuid not null references app.accounts(id),
  school_id         uuid references app.schools(id),
  username          text not null,
  auth_user_id      uuid,
  requested_payload jsonb not null,
  status            text not null default 'pending' check (status in ('pending','auth_created','completed','failed')),
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Generic idempotency ledger for consequential mutations (TRD §12.2, §17).
create table private.idempotency_keys (
  operation_id    uuid not null,
  school_id       uuid not null references app.schools(id),
  operation_type  text not null,
  actor_id        uuid not null references app.accounts(id),
  fingerprint     text not null,
  result          jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (school_id, operation_type, operation_id)
);

create trigger organizations_touch before update on app.organizations for each row execute function app.tg_touch();
create trigger schools_touch       before update on app.schools       for each row execute function app.tg_touch();
create trigger accounts_touch      before update on app.accounts      for each row execute function app.tg_touch();
create trigger memberships_touch   before update on app.memberships   for each row execute function app.tg_touch();
create trigger memberships_no_del  before delete on app.memberships   for each row execute function app.tg_no_delete();
