# PrimeCampus — Database Schema (V1)

Version: 1.0 · 5 October 2026 · Implements PRD v1.2 and TRD v1.0
Status: migrations written and tested locally against PostgreSQL 16 using a Supabase auth stub. **Not yet applied to any Supabase project.**

## 1. What is in the folder

```
supabase/migrations/            apply in filename order
  20261005000100_foundation.sql                     schemas, identity, sessions, idempotency
  20261005000200_school_setup.sql                   years, classes, sections, subjects, bell schedules, calendars
  20261005000300_people.sql                         students (UDISE+ 4.1 layout), guardians, enrollment/placement, staff
  20261005000400_admissions_imports_timetable.sql   leads, imports, timetable versions, lesson sessions, substitutions
  20261005000500_attendance_diary_homework.sql      student/staff attendance, diary, homework
  20261005000600_fees.sql                           fee config, invoices, collections, cheques, receipts
  20261005000700_salary_audit_telemetry.sql         salary snapshots, audit/auth/telemetry, export manifests
  20261005000800_security_rls.sql                   context resolution, capabilities, audit trigger, RLS on every table
  20261005000900_rpc_core_session.sql               login bootstrap, context switch, logout, telemetry, Edge (service_role) hooks
  20261005001000_rpc_academic.sql                   lessons, substitution, attendance, diary, homework, placement moves
  20261005001100_rpc_fees.sql                       invoicing, late fees, collections, cheques, reversals, statements, reports
  20261005001200_rpc_admissions_salary_operator.sql leads, admission/conversion, salary calculator, Operator console
  20261005001300_rpc_setup_master_reads.sql         setup/master CRUD + role-shaped reads
  20261005001400_lockdown_grants.sql                revoke EXECUTE from PUBLIC/anon (must stay last)
supabase/tests/
  00_supabase_stub.sql   local-only stand-in for auth.users/auth.uid()/auth.jwt() — NEVER apply to Supabase
  run_all.sh             rebuild local DB + apply all migrations
  test_scenarios.py      120 checks across PRD acceptance cases, run as `authenticated` with JWT claims
  test_concurrency.py    two collectors racing on one invoice
  sizing.sql             full-year synthetic load + size measurement
```

Totals: 67 tables in `app`, 10 in `private`, 91 RPCs in `public`, about 140 RLS policies.

## 2. Architecture (TRD §4, §7)

| Schema | Exposed to Data API | Contents |
|---|---|---|
| `public` | yes | 91 thin `SECURITY INVOKER` RPC wrappers only. No tables. |
| `app` | **no** | All school data. RLS on every table. Clients reach it only through RPCs. |
| `private` | **no** | Sessions, security helpers, audit, idempotency, telemetry. RLS on, no policies, no client grants. |

**Request path.** Browser → `public.<rpc>(p_ctx_rev, …)` → `private.<rpc>` (`SECURITY DEFINER`, `search_path=''`). The definer re-checks the session, context revision, capability and target school, then writes. Setup/master CRUD functions in 1300 are `SECURITY INVOKER`, so RLS is the enforcement layer there.

**Context.** The Supabase JWT proves who the user is (`sub`) and which session (`session_id`). `private.app_sessions` holds the server-chosen school, role and child for that session, plus a `context_revision`. Every RPC takes `p_ctx_rev`; a mismatch returns `STALE_CONTEXT`. Switching role or child bumps the revision, so an old tab can't act in the new context. Logout, membership disable and password reset end the app session immediately, even while the JWT is still valid.

**Capabilities.** `private.role_has_cap(role, cap)` is the single role→permission map. Only the *selected* role counts: Teacher and Parent grants are never combined. Admissions duty is a membership flag, not a role.

**Errors.** SQLSTATE `P0001`, with `hint` set to one of `UNAUTHENTICATED`, `FORBIDDEN`, `STALE_CONTEXT`, `VALIDATION_ERROR`, `CONFLICT`, `DUPLICATE`, `LIMIT_REACHED` or `NOT_FOUND`. PostgREST returns `hint`, so the app should map on it.

## 3. Conventions

- Every school-owned table has `school_id` and `UNIQUE (school_id, id)`. Children use **composite FKs** `(school_id, parent_id)`, so a row can never point into another tenant. Fee allocations go further and use `(school_id, invoice_id, student_id)`, which blocks paying a sibling's invoice.
- UUID primary keys for entities. `bigint` identity is used for high-volume internals (lesson sessions, attendance submissions, homework checks, audit).
- Money is `bigint` paise. Percentages are basis points. No floats.
- Business dates are `date`; instants are `timestamptz`. "Today" is school-local (`Asia/Kolkata`) via `private.school_today()`.
- Mutable rows carry `version` (auto-incremented by `app.tg_touch`), and updates require `expected_version`.
- History-bearing tables block `DELETE` (`tg_no_delete`); ledgers block `UPDATE` (`tg_immutable`). Records are retired, reversed or superseded instead.
- Effective-dated rows use `[effective_from, effective_to)` with `EXCLUDE USING gist` to prevent overlaps (placements, roll numbers, class teacher, timetable versions, academic years, bell schedules).
- Missing ≠ zero ≠ negative. No price row means "no price". No attendance row means **Unmarked**. No homework-check row means **Unchecked**.

## 4. Table catalog

### Platform & identity
| Table | Purpose |
|---|---|
| `organizations`, `schools` | Customer group → separately scoped schools; `schools.code` is the username prefix |
| `accounts` | 1:1 with `auth.users`; school-issued `username`; `must_change_password` is server-owned |
| `memberships` | (account, school, role) + `admissions_duty`; disabling one keeps the other schools |
| `private.platform_operators` | Operator grant |
| `private.app_sessions` | Server-held context per JWT session |
| `private.provisioning_operations` | Resumable Auth + DB provisioning |
| `private.idempotency_keys` | Replay-safe results for consequential mutations |

### Setup
`academic_years` (one `is_current`, no overlaps) · `classes` · `sections` (year-scoped) · `subjects` · `class_subjects` · `period_schedules` + `schedule_slots` (versioned bell schedules; breaks can't take subjects; slots can't overlap) · `staff_groups` · `calendar_patterns` (weekday defaults per audience/group) · `calendar_days` (dated overrides; must fall inside the year) · `attendance_modes` (daily/period with an effective date).

Calendar precedence (`private.resolve_day`): dated group override > dated default > group weekday pattern > default pattern > non-working. Student and staff calendars are independent.

### People
| Table | Notes |
|---|---|
| `students` | UDISE+ 4.1 general-profile layout (name, gender, DOB, parents, address/pincode, mobiles, email, mother tongue, nationality, blood group) + admission number/date |
| `student_sensitive` | **Admin/Operator only**: Aadhaar, name as per Aadhaar, PEN/APAAR (entered, never generated), social category, minority, BPL/AAY, EWS, CWSN/impairment/disability %, out-of-school, family income |
| `guardians`, `student_guardians` | Separate people; one primary per student; `portal_access` per link; same phone never merges |
| `enrollments` | Student ↔ year, `joined_on` (attendance and fee eligibility start here) |
| `placements`, `placement_batches` | Dated section membership + roll number; only `effective_to` can change |
| `staff` | One record per employee; login optional; a teacher is staff |
| `staff_salary_rates`, `staff_bank_accounts`, `staff_group_salary_defaults` | **Confidential**: Admin/Owner/Operator only |
| `teaching_assignments` | Subject or class-teacher duty, effective-dated |

### Admissions & imports
`leads` (Converted ⇔ `converted_student_id`; unique per student) · `lead_followups` (append-only) · `import_jobs`, `import_rows`, `import_source_keys` (manifest + row results; the source-key ledger outlives staging so re-imports can't duplicate).

### Timetable
`timetable_versions` (draft/active/retired, no overlapping active versions per section) · `timetable_entries` · `lesson_sessions` (actual dated lessons; planned vs actual teacher; explicit cancellation) · `substitutions` (one active per lesson; conflict override needs a reason).

### Attendance
| Table | Grain |
|---|---|
| `student_daily_attendance` | student × date, status P/L/H/A |
| `student_period_attendance` | **student × lesson** (founder decision), status P/L/A |
| `staff_attendance` | staff × date, status P/L/H/A |
| `attendance_submissions` | Shared header (actor, role, time, operation id), so rows stay narrow |
| `attendance_changes` | Old→new trail, written only when a marked value changes |
| `staff_paid_leave` | Approved paid leave used (0.5 / 1.0) |

### Diary & homework
`diary_entries` (one per lesson; lesson date ≠ entry time) · `homework_assignments` · `homework_checks` (completion + correction kept separately; `observed_on` ≠ `entered_at`; `completed_on` only if known) · `homework_check_changes`.

### Fees
| Table | Notes |
|---|---|
| `fee_heads`, `receiving_accounts`, `fee_terms`, `fee_structure_lines` | Config; retiring keeps history |
| `student_optional_fees` | Opt-in for optional heads (e.g. transport) |
| `concession_presets`, `concession_preset_heads`, `student_concessions` | Fixed or bp %; one concession per line; conflicts are reported, never guessed |
| `late_fee_rules` | One fixed charge per invoice per rule (unique index) |
| `invoices` + `invoice_lines` | Immutable issued snapshot; `source_key` idempotency; opening balances keep their origin |
| `invoice_adjustments` | Late fee, waiver, discount, extra charge, correction (signed; reason required) |
| `collections`, `collection_allocations` | Posted money; allocation ≤ remaining due; normalised UPI/bank reference unique per account |
| `cheques` | pending → cleared / bounced; pending never settles dues |
| `collection_reversals`, `reversal_allocations` | Corrections reopen dues; the original is never edited |
| `receipts`, `doc_sequences` | School/year sequence allocated under a row lock; immutable snapshot for reprints |
| `payment_exceptions` | Overpayment/unidentified money; never a credit wallet |

Balance = Σ line net + Σ adjustments − Σ allocations + Σ reversed allocations. It is computed in one place only, `private.invoice_balances()`.

### Salary
`salary_calculations`: versioned snapshots; only `final → superseded` may change. CHECK constraints enforce `payable = round(salary × (attended + paid_leave) / working)` and `paid ≤ working`. Verified: ₹40,000 × (15 + 1) / 20 = **₹32,000**.

### Audit & activity (private)
`audit_events` (trusted; written by trigger/definer in the same transaction; Operator-only) · `auth_events` (login/logout/reset/provision/context) · `telemetry_events` (browser-reported, ≤20/batch, ≤2KB) · `usage_daily` · `retention_settings` (telemetry 30d, aggregates/auth 400d) · `export_jobs`.

## 5. Access matrix (enforced in RLS and in RPCs)

| | Operator | Admin | Accountant | Principal | Owner | Teacher | Parent | Student |
|---|---|---|---|---|---|---|---|---|
| Setup write | ✓ | ✓ | fees config | – | – | – | – | – |
| Students (all) | ✓ | ✓ | read | read | – | own sections | selected child | self |
| Student sensitive | ✓ | ✓ | – | – | – | – | – | – |
| Attendance rows | ✓ | ✓ mark any | – | read | summary RPC | mark own lessons / class | child | self |
| Diary / homework | ✓ | ✓ correct | – | read | **–** | own lessons/sections | child (placement window) | self |
| Fees | ✓ | ✓ | ✓ manage | – | read | **–** | child | self |
| Staff salary / bank | ✓ | ✓ | **–** | **–** | read | – | – | – |
| Raw audit / logs | ✓ | – | – | – | – | – | – | – |

## 6. Decisions and deviations from the TRD

1. **Period attendance is one row per student per lesson** (founder, 5 Oct), replacing TD-05's compact day container. Rows are kept narrow with a `bigint` lesson id, a 1-char status, and actor/time on the shared submission header.
2. **Measured storage, full synthetic year** (800 students, 20 sections, 220 days × 7 periods, 2 homework tasks/section/day): period attendance 183 MB (1.23M rows), homework checks 87 MB, everything else ~30 MB → **~300 MB/year**. Year 1 fits the 500 MB free tier, but you'll cross it at roughly 18–20 months. Options then: Supabase Pro, archiving closed years, or switching to the compact container (~50 MB/yr).
3. UDISE+ is used as a **field layout only**, with no government sync. Reporting-sensitive fields sit in `student_sensitive`.
4. A group default salary lives in its own restricted table, so Principal can read staff groups without seeing pay.
5. Mid-month joiners: the month's full working days stay in W, and days before joining are unpaid. This pro-rates naturally and is flagged, rather than paying a full month.
6. Lessons on dates that became holidays are auto-cancelled only if unused. Recorded marks are never deleted.

## 7. Applying to Supabase

1. Create a **dedicated** project (Mumbai `ap-south-1`). Do not use the existing gym project.
2. Apply `supabase/migrations/*.sql` in order: `supabase db push` with the CLI, or one `apply_migration` call per file through the Supabase MCP. Never apply `tests/00_supabase_stub.sql`.
3. Leave Data API exposed schemas at the default (`public` only). Do **not** expose `app` or `private`.
4. Disable public sign-ups. Accounts are created by the provisioning Edge Function.
5. Run the security and performance advisors after applying.
6. Seed: one Operator account (`insert into private.platform_operators`), then create the school with `op_create_school`.
7. Any future migration that creates functions must end with the `1400_lockdown_grants` REVOKE block.

## 8. Not yet built (next pass)

- **Edge Functions** (TypeScript): `provision_account`, `reset_password`, `change_password`, `set_account_status`. The DB side (`private.svc_*`, service_role only) is ready.
- **Import RPCs**: `validate_import` / `commit_import_chunk` over the existing `import_*` tables. Opening balances already have `issue_opening_balance`.
- **Export RPCs**: `create_export_manifest` / `fetch_export_page` over `private.export_jobs`.
- Minor reads: section-level attendance history and a principal homework-coverage summary.
- Re-run the test suite against a real Supabase dev project (PG 17), not just the local stub.

## 9. Running the tests locally

```bash
supabase/tests/run_all.sh          # needs a local Postgres on /tmp:5433 (edit DSN to suit)
python3 supabase/tests/test_scenarios.py
python3 supabase/tests/test_concurrency.py
```
