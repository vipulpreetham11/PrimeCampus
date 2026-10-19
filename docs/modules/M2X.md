# M2X — Close out M0 … M2 (prompt to paste into Claude Code)

Read `CLAUDE.md`, `docs/reports/M0.md`, `M1.md`, `M1b.md`, `M2.md` (especially every "Not verified" / "Known gaps"
section) and **`supabase/migrations/20261005002310_m0_m2_hardening.sql`** (read its header first; it is live).

Goal: when this module is merged, **nothing built in M0, M1, M1b or M2 is unverified or knowingly unfinished**.
Branch `module/m2x-closeout` from `main`. No backend changes — if an RPC behaves differently from this brief, stop and
tell me. No new product features beyond what is listed.

## 0. Repo hygiene (first commit)
- If `.gitattributes` doesn't exist yet: add `* text=auto eol=lf` plus `binary` rules for png/jpg/xlsx/pdf, run
  `git config core.autocrlf false` and `git add --renormalize .`; commit only if something changed. Lint must pass with
  no line-ending noise on Windows.
- `package.json` needs Node ≥ 22: add an `.nvmrc` with `22`.
- `npm audit` shows 2 moderate (uuid < 11 via exceljs). Add `"overrides": { "uuid": "^11.1.1" }`, `npm install`, then
  prove the import parsing still works (all M1b parse/wizard tests + one real `.xlsx` round trip). If exceljs breaks with
  uuid 11, revert and report — never `npm audit fix --force`.

## 1. Adopt migration 2310
Regenerate `src/generated/database.types.ts` from the live project and `npm run gen:rpc`.
- **Readable errors:** older setup RPCs now return hinted errors with `details.field` (e.g. `name`, `code`, `phone`,
  `employee_no`, `pincode`, `udise_code`, `aadhaar_number`, `capacity`). Where a form has that field, show the message
  under the field (otherwise in the form's error area). Cover every M1 form that calls: save_school_profile,
  save_academic_year, save_class, save_section, save_subject, save_class_subjects, save_period_schedule,
  save_calendar_pattern, save_calendar_range, set_attendance_mode, save_staff_group, save_staff, save_staff_finance,
  save_teaching_assignment, end_teaching_assignment, save_guardian, update_student, save_student_sensitive.
  One shared helper, not per-form code. Unit test: DUPLICATE on class name lands under the Name field.
- **Staff group default salary:** `save_staff_group(..., p_clear_default_salary)` → a "Clear default salary" action
  (needs `staff_finance.manage`). Show "No default salary" vs "₹0" distinctly.
- **Timetable:** `activate_timetable(p_version_id, p_expected_version)` — send the draft's version; CONFLICT → reload;
  a repeat returns `replayed: true` (treat as success). `copy_timetable` and a new draft from `save_timetable_draft` now
  return **DUPLICATE with `details.timetable_version_id`** when the section already has a draft on that start date →
  "This section already has a draft starting on <date>" + **Open it**. After an uncertain failure, a retry is now safe:
  DUPLICATE means the earlier attempt worked → open that draft. Keep the existing "checking…" behaviour but simplify it
  to rely on this.
- **Homework create:** the same lesson + same text again returns **DUPLICATE with `details.assignment_id`** → treat as
  saved ("Already set for this lesson"), close the dialog. A retry after an uncertain failure is therefore safe.
- **Homework roster:** use `can_check` from `get_homework_roster` (remove the guessing described in M2 mismatch 2).
- **Teacher Today:** `homework_to_check` now has `subject`, `section`, `assigned_on`, `eligible` — show
  "Maths · Class 1 A — 12 of 28 checked, due 21 Oct".
- Update the M2 report's mismatch list (items 2, 4, 5 are resolved).

## 2. UI fix
- At 375px the admission number is cut to "DEMO-S…" next to "Not saved". A tooltip doesn't work on a phone: the full
  admission number must be readable without hover. Put the state badge on the right of the name line or let the
  admission number wrap to its own short line; row height may grow to ≤ 72px. Update the mocked layout spec limits.

## 3. Live verification — Demo School only (assert "Demo School" first; unique names per run)
Write Playwright tests (preferred) or, where a test would be unreasonable, exact manual steps you performed, with the
result. Every item below ends up ✅ verified live, or ❌ with the reason and what would be needed. Nothing silently
skipped.

**M0**
1. Multi-role chooser and switching (`demo.teachparent`: teacher ↔ parent); switching clears data and other tabs follow.
2. `must_change_password` flow incl. the re-sign-in fallback (force it, e.g. by making the first sign-in path fail in
   the test, or explain why it can't be forced).
3. Security headers + SPA fallback as Cloudflare will serve them: `npm run build` then `npx wrangler dev` (local, no
   deploy) — check every header from `public/_headers` on `/`, a nested route reload, and a missing `/assets/x.js` → 404.
   No CSP violations in the console while using the app.

**M1** — school profile save · attendance-mode change · staff salary rate + bank save · ending a teaching assignment ·
admissions-duty toggle · unlinking a login · sensitive-identifiers save · guardian edit/add · placement move ·
enquiry edit · disable/enable a login (incl. its FORBIDDEN message for a non-admin) · Staff calendar tab and
staff-group calendars · "Load more" on students and enquiries (create enough Demo rows through the importer/UI to pass
50) · a **Principal** login (provision `demo.principal` through the UI if missing): sees read-only views, gets
FORBIDDEN on writes · offline state on one M1 list and one M1 form (Playwright `setOffline`).

**M1b** — Continue after a real network failure during staging and during commit (`setOffline`) · Restore a removed
row · the "no rows processed" guard · "Load more" on a job with > 100 rows · a Windows-1252 CSV (generate one with
Excel-style bytes) · a lossy UTF-8 CSV · a workbook with a hidden first sheet · formulas with empty results · a large
file: 10,000 rows / ~5 MB **staged and validated, then the import closed without committing** (don't create 10,000
Demo students) — record parse time and memory.

**M2**
- **Period-wise attendance:** set Demo School to period-wise **from today** with the app's attendance-mode setting,
  then: teacher marks a period lesson (mark remaining present + 2 exceptions); a second tab changes one student → the
  conflict is shown and resolved; a substitute marks a covered period lesson. Afterwards set Demo School back to
  day-wise **from tomorrow** (so the day-wise tests keep working on future dates) and record both dates in the report.
- Parent (`demo.parent`) sees **real** data for today: attendance record, a diary note and a checked homework state
  (create them today first); cannot open the other child's data by URL.
- Lesson cancel / restore / change subject · remove a substitute · the override reason after a clash CONFLICT ·
  attendance overview · diary list incl. "Missing diary only" · homework edit and cancel · discard a draft · copy a
  timetable to another section (+ the new DUPLICATE "Open it" path) · leave-with-unsaved-marks dialog ·
  "Load more" on homework and diary lists if > 50 rows exist (else say so).
- Refresh **all** `m2-screens/` from a live run (the roster ones are from mocked data now).

Run the **full live suite** (M0 + M1 + M1b + M2 + the new tests) twice in a row at the end; both must pass.

## Done when (record in `docs/reports/M2X.md`)
- [ ] `typecheck`, `lint`, `test`, `build`, `check:bundle` pass on Node 22; `npm audit` 0 vulnerabilities (or the
      exact reason it can't be); no `.from(`; no browser storage.
- [ ] Every item in §3 has ✅ or ❌-with-reason; a table per module.
- [ ] Full live suite passed twice in a row (numbers + duration).
- [ ] Demo School data created by this module listed (incl. the attendance-mode rows).
- [ ] Earlier reports' "Not verified" sections are not edited — this report supersedes them item by item.

Stop when done. Don't merge, don't start M3.
