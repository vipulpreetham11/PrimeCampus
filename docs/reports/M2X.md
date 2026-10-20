# M2X — Close-out of M0 … M2: module report

Branch: `module/m2x-closeout` (from `main` at `9df3793`) · Date: 19 Oct 2026 · Brief: `docs/modules/M2X.md`

This report **supersedes item by item** the "Not verified" / "Known gaps" sections of `M0.md`, `M1.md`,
`M1b.md` and `M2.md` (those sections are not edited). The only change to an earlier report is the M2
mismatch list (items 2, 4, 5 marked resolved by migration 2310), as the brief asks.

No backend changes (no migration, no Edge Function). Migration 2310 was already live (checked with
`list_migrations`).

## Summary

- **§0 Repo hygiene:** `.gitattributes` gained `*.pdf binary` (the LF rules were already committed in
  `7572594`; renormalize changed nothing); `.nvmrc` = `22`; `overrides.uuid = ^11.1.1` → **`npm audit`:
  0 vulnerabilities**. exceljs still works with uuid 11: all M1b parse/wizard tests pass on Node 22
  (including the 4 that failed under Node 20 in M2), plus a new round trip through the only exceljs path
  that calls uuid (a data-bar rule). Note: the browser loads exceljs's prebuilt `dist/exceljs.min.js`,
  which bundles its own uuid 8; exceljs only calls `uuidv4()` without a buffer, which the advisory
  (v3/v5/v6 with a buffer) doesn't cover.
- **§1 Migration 2310 adopted:** types regenerated from the live project (via the Supabase MCP
  generator; 138 RPC wrappers). Field errors under the field (one helper, 14 forms); "Clear default
  salary"; versioned timetable activation (+ the replay reply, which our schema rejected — fixed);
  DUPLICATE-based create checks for copy timetable / new draft / homework (+ "Open it"); homework roster
  `can_check`; Teacher Today line. M2 report mismatches 2, 4, 5 marked resolved.
- **§2 375px rows:** the admission number is always shown in full (wraps, never truncated; no tooltip).
- **§3 Live verification:** new specs `m2x-m0`, `m2x-headers`, `m2x-m1`, `m2x-m1b`, `m2x-m2`,
  `m2x-keyboard`; `m2.spec.ts` adjusted for the period-wise day. Every item is ✅ or ❌ with a reason
  (tables below).
- **Owner requests during the module:** static-assets-only deploy kept; `/assets` 404 marked ❌; instead
  the app **recovers from a stale deploy** by reloading once (`vite:preloadError` and failed lazy route
  imports; loop guard without browser storage). wrangler pinned as a devDependency.
- **Bugs found by the live verification and fixed** (each with a unit test where it is code):
  1. `activate_timetable` repeat (`replayed: true`, no `next_step`) was reported as an unexpected shape.
  2. **CSP:** every page load reported a `script-src eval` violation — Zod 4 probes `new Function` when
     it builds object schemas. `src/lib/zod.ts` sets `jitless`; all imports use it; ESLint enforces it.
  3. **Weekly pattern** for a staff group with nothing saved (group nor default): the dialog showed a
     made-up week as "School default" and saved nothing, while the calendar showed every day as a weekly
     off. Such days now say "Not set yet" and are saved.
  4. **Offline search showed the old results** (`keepPreviousData`): "Showing 50 students" for a new,
     un-run search. `DataState` now shows "You are offline" for a paused new query.
  5. **Offline saves were silently paused** ("Saving…", sent later on their own): mutations now use
     `networkMode: 'always'` → immediate "You appear to be offline… Nothing was changed".
  6. **Import "No rows were processed" → Reload** left the notice up; it now returns to the job's state.
  7. **Dialog focus:** dialogs opened from state (no `DialogTrigger`) dropped the focus to `<body>` on
     close; `DialogContent` now returns it to the opener.
  8. `m2.spec.ts` test 2 (period marking, never run before) had an ambiguous "Saved" check and a
     non-alternating change; fixed.

## "Done when" checklist

| Item | Status | How |
|---|---|---|
| `typecheck`, `lint`, `test`, `build`, `check:bundle` on Node 22 | ✅ | Node v22.19.0. `test`: **21 files / 326 passed**. `lint` = ESLint (incl. React Compiler rules, new `zod` import rule) + `prettier --check`. `check:bundle`: initial JS **232.2 KB gzip** (budget 300 KB); spreadsheet libraries lazy. |
| `npm audit` 0 vulnerabilities | ✅ | `found 0 vulnerabilities` (with uuid override and wrangler 4.149.0). |
| No `.from(` | ✅ | `grep -rn "\.from(" src tests` (ignoring `Array.from`/`Buffer.from`): none. Every spec's network audit: only `/rest/v1/rpc/*`, `/auth/v1/*`, `functions/v1/accounts`; `p_ctx_rev` on every school RPC. |
| No browser storage | ✅ | `grep -rn "localStorage\|sessionStorage\|indexedDB" src`: none (the stale-deploy loop guard uses a URL marker, not storage). |
| Every §3 item ✅ or ❌-with-reason, a table per module | ✅ | Below. |
| Full live suite passed twice in a row | ✅ | Runs 3 and 4: **74 / 74** passed each (7.1 and 7.7 min). Earlier runs 1–2 and their failures are listed under "Full live suite". |
| Demo School data created by this module listed | ✅ | Below, incl. the attendance-mode rows. |
| Earlier "Not verified" sections not edited | ✅ | Only the M2 mismatch list was annotated (brief §1). |

## §3 Live verification — M0

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Multi-role chooser and switching (`demo.teachparent` Teacher ↔ Parent); switching clears data; other tabs follow | ✅ live | `m2x-m0` M0-1: chooser shows Teacher + the Parent's child (Kabir Rao). Tab A switches Teacher→Parent; tab B (Teacher-only screen open) follows: summary shows Parent/Kabir Rao, the "changed" notice, same revision as tab A; **no query of the old revision holds data** (its open screen re-queries under the old revision while the new context loads; the server refuses those with STALE_CONTEXT, so empty entries may remain — asserted none has data, via a test-only hook). Switching back in tab B makes tab A follow. |
| 2 | `must_change_password` incl. the re-sign-in fallback | ✅ live (forced) | M0-2: temp password → only `/change-password` reachable. The fallback is forced: the first `bootstrap_account` after `change_password` is answered with 401 `PGRST301` ("JWT expired"), as when Auth revokes the session; the app signed in again with the new password (exactly one `/auth/v1/token` call) and reached the chooser. Temp password no longer works. |
| 3 | Security headers + SPA fallback under `npx wrangler dev`; no CSP violations | ✅ headers + fallback + CSP · ❌ `/assets/x.js` → 404 | `m2x-headers` (builds production `dist`, serves it with `wrangler dev`, nothing deployed). Every header of the `/*` rule on `/` and on a reloaded nested route (200, app boots). A real asset: `immutable` + all headers. **CSP: 0 violations** across 15 screens as signed-in Admin (after fixing the Zod eval probe). **❌ missing `/assets/x.js` returns 200 + `index.html`:** with static assets only (no Worker), Cloudflare's SPA fallback answers every unknown path, script requests included (confirmed in the asset-worker source and with a real browser). Owner decision: keep static-assets-only. The browser refuses to run it (nosniff + strict MIME, asserted) and the app reloads once to fetch the current assets (stale-deploy recovery). Also: the `/index.html → Cache-Control: no-cache` rule only meets the redirect `/index.html → /`; `/` gets Cloudflare's own `public, max-age=0, must-revalidate` (same effect). |

## §3 Live verification — M1

| Item | Result | Evidence (`m2x-m1`, 8 passed) |
|---|---|---|
| School profile save | ✅ | M1-1: city alternates per run, saved, persists after reload. |
| Attendance-mode change | ✅ | `m2x-m2` M2-1 (Setup → Attendance mode, both rows). |
| Staff salary rate + bank save | ✅ | M1-1: run-unique future rate for Lata Iyer; bank details saved, number masked (last 4). |
| Ending a teaching assignment | ✅ | M1-1: a one-day Science assignment for Meera Rao in Class 2 B, starting on the first free day after earlier runs' rows (the same teacher/section/subject may not overlap — the 2310 message "This teacher already teaches this subject…" showed when it did), ended → "From X to X". |
| Admissions-duty toggle | ✅ | M1-2: on → `demo.teacher` gets Admissions (nav + page); off → access gone. |
| Unlinking a login | ✅ | M1-3: `demo.principal` unlinked from Lata Iyer's staff record, then linked again. |
| Sensitive-identifiers save | ✅ | M1-4: run-unique Aadhaar saved; the same number for another student → **2310 DUPLICATE shown under the Aadhaar field** (not a form error). |
| Guardian edit / add | ✅ | M1-4: "Add → New person" (father) linked; occupation edited. |
| Placement move | ✅ | M1-4: Move 1 selected → Class 2 B from today → profile history. |
| Enquiry edit | ✅ | M1-5: child's name + class wanted, persists. |
| Disable / enable a login, incl. FORBIDDEN for a non-admin | ✅ | M1-3: disabled `demo.principal` can't sign in; enabled again. The Principal calling Edge `set_status` → FORBIDDEN; `/users` → "You don't have access". |
| Staff calendar tab and staff-group calendars | ✅ (+ bug fixed) | M1-6: Staff tab → "Office staff": Saturday alternates working/weekly off; the default staff calendar is unchanged. Found bug 3 (above). |
| "Load more" on students and enquiries (> 50) | ✅ | M1-4/M1-5: students topped up through the importer, enquiries through the UI; 50 shown, Load more adds the rest. |
| Principal login: read-only views, FORBIDDEN writes | ✅ | M1-3: `demo.principal` provisioned **through the UI** (temp password shown once, forced change); students/profile/classes/staff without write controls; `save_class`, `update_student`, `save_staff` FORBIDDEN. M2 screens: `m2x-m2` M2-10. |
| Offline on one M1 list and one M1 form | ✅ (+ 2 bugs fixed) | M1-7 (`setOffline`): a new students search offline → "You are offline" (was: the previous 50 rows); school profile saved offline → "You appear to be offline… Nothing was changed", input kept (was: silently paused). |
| Keyboard-only walkthroughs (M1/M1b/M2 reports) | ✅ (+ bug fixed) | `m2x-keyboard` (4 passed): sign-in and navigation with Tab/Enter (visible focus); dialog Enter/Escape with focus kept inside and **returned to the opener** (bug 7 fixed); row action menu; a day register with ↓/↑/End, letter shortcuts, Enter to save. |
| Screen-reader checks | ❌ | Needs a person with NVDA/TalkBack/VoiceOver; not automatable here. The structure it relies on (labels, roles, live regions, focus) is what the specs assert. |

## §3 Live verification — M1b

| Item | Result | Evidence (`m2x-m1b`, 7 passed) |
|---|---|---|
| Continue after a real network failure during staging | ✅ | M1b-1: 1,200 staff rows (3 batches); the browser goes offline after batch 1 → "Continue uploading" → all checked; closed, nothing imported. |
| … and during commit | ✅ | M1b-2: the browser goes offline exactly as the 2nd commit chunk is sent (a real network failure) → "Some rows may already be imported — choose Continue" → Continue → done. |
| Restore a removed row | ✅ | M1b-2. |
| The "no rows processed" guard | ✅ (forced) | M1b-3: one `commit_import_chunk` reply rewritten to `processed: []` (the state can't be produced on demand) → the notice → Reload → the job's real state (bug 6 fixed). |
| "Load more" on a job with > 100 rows | ✅ | M1b-2: 110 rows → 100, Load more → 110. |
| Windows-1252 CSV | ✅ | M1b-4: accents, en dash, ’ intact (checked in the row and its Edit dialog). |
| Lossy UTF-8 CSV | ✅ | M1b-4: Telugu name intact; "…show as � in row 3" warning; the row shows �. |
| Workbook with a hidden first sheet | ✅ | M1b-4: the first visible sheet is read. |
| Formulas with empty results | ✅ | M1b-4: `IF(1=1,"","x")` → blank optional cell, row Ready. |
| Large file 10,000 rows / ~5 MB staged + validated, closed without committing; parse time + memory | ✅ | M1b-5: **4.80 MB, 10,000 students rows: parse + column matching 0.7–0.9 s; upload + server check 30.9 s / 55.9 s / 41.0 s (three runs)**; closed, no student created. Main-thread JS heap 13 → 13 MB (parsing runs in a Web Worker; `performance.memory` doesn't see worker memory — **worker memory not measured**). |
| Parent-mobile alias; skipped empty rows; leave-mid-upload confirmation (M1b known gaps) | ✅ | M1b-4: "Mobile" auto-matched to Parent 1 mobile; a row with data only in an unimported column skipped and named (fully blank rows are dropped while reading); M1b-5: leaving during the upload asks first, Stay keeps it going. |
| Main-thread parsing fallback (M1b known gap) | ✅ | M1b-7: with `Worker` missing, and with a Worker that can't start, the file is parsed on the main thread. |
| Disabled Import for a role without the dataset capability | ❌ | No live role has `imports.manage` without the dataset capability (only Operator and Admin have it, and they have all). Covered by the component test in `m1b-pages`. |
| Real school spreadsheets | ❌ | None available (PRD §20 asks for anonymized samples before live imports). |
| Partly uploaded imports can't be detected | ❌ (backend) | The server keeps no "expected row count" for a job; needs a backend change (unchanged from M1b). |

## §3 Live verification — M2

Attendance mode (Setup → Attendance mode, first run): **period-wise from 19 Oct 2026**, **day-wise again
from 20 Oct 2026**. Both rows are permanent; re-runs see the 2310 DUPLICATE under "Starts on".

| Item | Result | Evidence |
|---|---|---|
| Period-wise: teacher marks a period lesson (mark remaining present + 2 exceptions) | ✅ | `m2.spec.ts` test 2 on 19 Oct (it never ran before): Ravi Kumar's English lesson. |
| Second tab changes a student → conflict shown and resolved | ✅ | `m2.spec.ts` test 2: "Someone else saved …" → Keep theirs. |
| A substitute marks a covered period lesson | ✅ | `m2x-m2` M2-2: Meera Rao absent on 19 Oct → Ravi Kumar substitutes her Period 1 → marks it from Today (not blocked). |
| Parent sees real data (attendance record, diary note, checked homework); not the other child by URL | ✅ | M2-3 (19 Oct): Aarav's record lists the period lessons; the diary note; the homework "Completed"; `/students/<Anaya>` → no access (server FORBIDDEN also in `m2.spec.ts` test 7). |
| Lesson cancel / restore / change subject | ✅ | M2-4 (next Monday, Class 1 A Period 1; subject changed back afterwards). |
| Remove a substitute | ✅ | M2-4. |
| Override reason after a clash CONFLICT | ✅ | M2-4: Meera Rao for Class 1 A Period 3 while she teaches Class 1 B ("Has another lesson then"; Class 1 B's lessons generated with Update lessons first) → reason → "Assign anyway". |
| Attendance overview | ✅ | M2-5 (19 Oct). |
| Diary list incl. "Missing diary only" | ✅ | M2-5. |
| Homework edit and cancel | ✅ | M2-5. |
| Discard a draft | ✅ | M2-6. |
| Copy a timetable to another section + the DUPLICATE "Open it" path | ✅ | M2-6: copy to Class 2 B; the same copy again → "This section already has a draft starting on …" → Open it opens that draft; discarded. |
| Leave-with-unsaved-marks dialog | ✅ | M2-7: Stay keeps the change; Leave without saving leaves. |
| "Load more" on homework and diary lists if > 50 rows | not applicable | M2-8: Demo School has 12–26 homework rows (each full run adds about 3) and 16 diary rows (63 days) — one page. Paging is unit-tested (M2). |
| Principal on M2 screens (M2 report) | ✅ | M2-10: overview, staff register (no Save), homework checks read-only; `mark_staff_attendance` / `mark_student_attendance` FORBIDDEN. |
| All `m2-screens/` refreshed live | ✅ | `m2.spec.ts` run on 19 Oct rewrote all five (`375-teacher-today`, `375-marking-roster`, `375-timetable-grid`, `375-parent-child-home`, `375-homework-roster`). The roster rows show full admission numbers; names of the M1b test students truncate because their roll numbers are long. |

`m2.spec.ts` changes: PAST is the latest **day-wise** working day; test 2 uses the latest period-wise
day; test 7 no longer asserts that Aarav has no attendance/diary (he has, since 19 Oct).
`m2x-m2` M2-2/M2-3 use 19 Oct explicitly, so they also run on later days.

## Full live suite

All specs in `tests/e2e` (M0 6 + M1 12 + M1b 8 + M2-layout 3 (mocked) + M2 9 + M2X: m0 3, headers 4,
m1 8, m1b 7, m2 10, keyboard 4 = **74 tests**), serial, live backend, Demo School only.

| Run | Result | Duration |
|---|---|---|
| 1 | 61 passed, 2 failed, 11 not run | 5.9 min |
| 2 | 70 passed, 1 failed, 3 not run | 7.4 min |
| **3** | **74 passed, 0 failed** | **7.1 min** |
| **4** (right after 3) | **74 passed, 0 failed** | **7.7 min** |

Runs 3 and 4 are the two passing runs in a row. What failed before them:
- Run 1, `m2x-m2` setup: Supabase answered the Edge `reset_password` with
  `SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED` ("Service is temporarily unavailable") — a platform outage.
- Run 1, `m2x-keyboard` K-2: the test read the focus before Radix restores it (a `setTimeout(0)` after the
  dialog unmounts). Fixed in the test (it polls); not an app bug.
- Run 2, `m2.spec.ts` test 5: the homework was set (the dialog closed as on success) but did not appear in
  the lesson's list within 30 s. Not reproducible (it passed in a separate re-run and in runs 3–4); it came
  minutes after the Edge degradation above. **Not explained** — recorded as a possible transient backend
  failure, not as fixed.

## §1 / §2 details

- **Field errors:** `handleSaveError(e, { form, fields })` → `applyServerFieldError` puts a 2310
  VALIDATION_ERROR/DUPLICATE with `details.field` under that react-hook-form field (aliases for
  `monthly_salary`, `default_salary`, `family_annual_income`); otherwise the form's error area. Wired into
  the forms of save_school_profile, save_academic_year, save_class, save_section, save_subject,
  set_attendance_mode, save_staff_group, save_staff, save_staff_finance (salary + bank), save_guardian
  (edit + new), update_student, save_student_sensitive. Screens without RHF fields (class subjects, bell
  schedule, calendar ranges/patterns, teaching assignments, end assignment) show the message in their
  error area. Unit: DUPLICATE on a class name under Name. Live: the Aadhaar DUPLICATE, the mode DUPLICATE.
- **Clear default salary:** marks the removal, Save sends `p_clear_default_salary` with the version;
  emptying the amount is not a removal; "No default salary" vs "₹0.00" in the table.
- **Timetable / homework creates:** after an uncertain failure the "checking…" step re-sends the same
  request; DUPLICATE with the existing id = the earlier attempt worked. First-press DUPLICATE: "Open it"
  (draft) / "Already set for this lesson" (homework). `findCopiedDraft` / `findCreatedHomework` removed.
- **375px rows:** name on its own line; state badge + reference share line 2 and the reference wraps to
  its own line when needed. Mocked spec at 72px: day register 66–67px, staff 66–67px, homework
  60–61px. Known limit (owner-accepted): a 23-character admission number takes two lines (row ≤ 88px,
  asserted separately).

## Stale-deploy recovery (owner request)

`src/lib/stale-deploy.ts`: `vite:preloadError` and a failed lazy route import (`RouteError`) reload the
page once. The reload URL carries `__pc_reload=<time>`, removed from the address bar before the router
reads it; a failure within 60 s of such a reload doesn't reload again — the "PrimeCampus was updated —
Reload" page is shown. Unit tests (`stale-deploy.test.tsx`): browser messages, marker add/strip, no
loop, preloadError handled vs. not, a failing lazy route reloads once and stops after.

## Demo School data created by this module

All through the UI unless noted; Demo School only; logins `demo.*` (their passwords are reset every run).
- **Attendance modes:** period-wise from **2026-10-19**, day-wise from **2026-10-20** (permanent).
- **Login `demo.principal`** (Principal, linked to Lata Iyer's staff record; ends enabled).
- Students `M2X<run>-n` ("M2x<run> Pupil…") in Class 2 A (9 on the first run, 2 per run after), one per
  run moved to Class 2 B, with a second guardian "M2x<run> Father" and an Aadhaar number.
- Enquiries "M2x<run> Enquirer n" (40 on the first run, 1 per run after); one edited per run.
- Class "M2X Bulk" with sections B001–B110 in the **non-current** year 2027-28 (once).
- Lata Iyer: a future-dated salary rate per run and bank details. Meera Rao: one-day Class 2 B Science
  assignments (ended). Office staff calendar: a weekly pattern (Saturday alternates). School profile city
  alternates. Teacher admissions duty toggled (ends off).
- 19 Oct 2026: staff attendance (Meera Rao absent), Ravi Kumar substituting her Period 1, period
  attendance of Class 1 A Periods 1–2, a diary note and a homework (Aarav: Completed) on Ravi's English
  lesson. 17 Oct: day-register changes (keyboard test).
- 26 Oct 2026 (next Monday): Class 1 B lessons generated; Class 1 A Period 1 cancelled/restored/subject
  changed back; a substitution on Period 3 added and removed; a homework created and cancelled.
- Timetable drafts copied to Class 2 B and discarded.
- Import jobs staged and **closed without importing** (staff 1,200 rows; encoding/workbook/alias files;
  10,000 students rows; no-worker files).

## Not verified / limits (❌ with reason)

- `/assets/x.js` → 404 under static assets only (owner: keep the deploy model; mitigated as above).
- Screen readers (needs a person with a screen reader).
- Import disabled for a role without the dataset capability (no such live role; unit-tested).
- Real school spreadsheets (none available); detecting partly uploaded imports (needs a backend field).
- Worker memory for the 10,000-row parse (only main-thread heap is measurable from a page).
- "Load more" on homework/diary live (fewer than 50 rows exist).
- From M0's notes, unchanged by design: the request id of RPC errors is client-generated (PostgREST
  exposes none); the container-only CA step for E2E doesn't apply on normal machines.

## Changes outside tests

- `src/lib/save-feedback.ts` (field errors), `src/lib/create-check.ts` (DUPLICATE helpers),
  `src/lib/dates.ts` (`formatDayMonth`), `src/lib/stale-deploy.ts` (new), `src/lib/zod.ts` (new; every
  `zod` import switched to it), `src/lib/query-client.ts` (mutations `networkMode: 'always'`).
- `src/components/shared/{MoneyText,DataState,roster-ui}.tsx`, `src/components/ui/dialog.tsx`.
- `src/app/{RouteError,router,e2e-hooks}.tsx|ts`, `src/main.tsx`.
- Features: setup (Classes, SchoolProfile, Subjects, Years, AttendanceMode, Calendar), staff
  (StaffGroups, StaffFinance, StaffForm, hooks), students (GuardianDialogs, Sensitive, StudentEdit),
  timetable (Editor, TimetablePage, hooks, new `draft-create.tsx`), homework (FormDialog, Roster, List,
  hooks), diary (LessonPage), teacher (Today), imports (ImportJobPage).
- Contracts: `timetable.ts`, `academic.ts`; generated `database.types.ts` + `rpc/functions.ts`.
- `eslint.config.js` (no direct `zod` import in `src`).

## Tests added / changed

- Unit: `m2x.test.tsx` (new), `stale-deploy.test.tsx` (new), `components.test.tsx` (DataState offline
  placeholder, dialog focus), `m1-review.test.tsx` (salary message, pattern "Not set yet"),
  `m1b-pages.test.tsx` (Reload), `m1b-parse.test.ts` (uuid round trip), `m2-review.test.tsx` (re-send
  flow, activation), `m2-pages.test.tsx` + `m2-fixtures.ts` (`can_check`).
- E2E: `m2x-m0`, `m2x-headers`, `m2x-m1`, `m2x-m1b`, `m2x-m2`, `m2x-keyboard` (new); helpers `ui.ts`,
  `imports.ts` (new); `m2.spec.ts`, `m2-layout.spec.ts` (72px, full reference), `globals.d.ts`.

## Dependencies

- `wrangler` **4.149.0** (devDependency, pinned): needed to serve `dist` with `public/_headers` and the
  SPA fallback exactly as Cloudflare does, locally (`npx wrangler dev`, no deploy). 4.149.0 is the oldest
  release without the vulnerable `sharp` (4.147.0 added 3 high advisories).
- `overrides.uuid` `^11.1.1` (for exceljs; no new direct dependency).

## How to run the live suite

`.env.local` (git-ignored) holds `E2E_OPERATOR_USERNAME` / `E2E_OPERATOR_PASSWORD`; export them into the
shell, then `npx playwright test` (all specs, serial; Demo School only).

## Test date fix (20 Oct 2026)

Branch `test/m2-date-fix` (from `main` at `4b13433`). Test code only: `tests/e2e/m2.spec.ts` and
`tests/e2e/m2x-m2.spec.ts`. No app, backend or helper changes.

### What depended on today's date

Both specs were written on 19 Oct and treated it as "today". Demo School is period-wise on **19 Oct
2026** only and day-wise from **20 Oct 2026**. `get_setup_snapshot.attendance_modes` lists only the
mode in force today plus later changes, so from 20 Oct the 19 Oct row is no longer listed.

| Where | Problem | Now |
|---|---|---|
| `m2.spec` dates | PAST = latest day-wise school day ≤ today, and the period day was found from the snapshot. From 20 Oct the snapshot has no period row, so **test 2 skipped itself**, and PAST moved forward every day. | Fixed days: period day **19 Oct**, PAST **20 Oct**, START = Monday of PAST's week (19 Oct). `beforeAll` checks both are still student school days (fails loudly otherwise). |
| `m2.spec` FUT | Next working day in a ±14-day calendar window. | Next school day after today from the student calendar whose day a week later is also a school day (test 6 checks both). |
| `m2.spec` test 1 | Update lessons from START to today+13. After about 9 Nov that is over the server's 63-day limit (`LIMIT_REACHED`). | The range starts at START or at (today+13 − 62), whichever is later. Past lessons are never refreshed by the server, and those of the fixed days already exist (and are marked). |
| `m2x-m2` M2-1 | When a mode row existed in the past, it filled **today** into "Starts on" and saved. From 21 Oct that would have **added a real "Daily attendance from 21 Oct" row** to Demo School (permanent). On 20 Oct its snapshot assertion failed (the M3 report's M2-1 failure). | Writes only a start date of today or later (create, or DUPLICATE under "Starts on" on a re-run). A past start date: the form shows "A change cannot start in the past", and no `set_attendance_mode` request is sent (counted). Then it reads each fixed day's mode from the server (`get_marking_roster.mode_on_date` as `demo.admin`: 19 Oct `period`, 20 Oct `daily`) and checks Setup shows today's mode. |
| `m2x-m2` M2-4/M2-5 | "Next Monday" = today's date + n, holiday or not. | The first Monday after today that is a student school day (calendar). |
| `m2x-m2` M2-6 | Copy start = today + 30…129 days. From late November that is after the academic year ends (31 Mar 2027 → `VALIDATION_ERROR`). | A per-run date between tomorrow and the end of the current academic year. |
| `m2x-m2` M2-7 | Opened **today's** day register (no lessons on a holiday or a Sunday). | The fixed day-wise day, 20 Oct (nothing is saved). |

Checked live after the runs: Demo School's attendance modes are still exactly period from 19 Oct and
daily from 20 Oct.

### `m2.spec` test 6 (timetable change → regenerate): not a date problem

The failure (M3 full run 2, and M2X run 2 in test 5): the homework was saved, the dialog closed, and
the homework did not appear in the lesson's homework list within 30 s.

- **Not caused by the dates.** Test 6 never used the fixed past days; its FUT is the next school day,
  which is the same on every run of a day. Runs that passed used the same FUT as the runs that failed
  (M2X runs 1–4 on 19 Oct; today's M3 run 1). The M2X failure was in test 5, on a different (past)
  lesson, as the teacher. What the two have in common is the lesson page's homework list after
  "Set homework".
- **Live data (read-only SQL) of the failed M3 run 2:** the homework "Bring the reading log — 4EUF5"
  was created at 03:26:16 UTC on the right lesson (21 Oct Period 2), and no 21 Oct timetable version
  was created. So the run stopped exactly at "homework listed". In the passing run 1, the version
  followed the homework 0.5 s later.
- **Ruled out by reading the code:** the list is `list_homework` for the section and the lesson date
  (first page of 50), filtered by lesson. Class 1 A has at most 15 active homework on any date (after these runs), so
  paging is not the cause. The text is unique per run, so it is not a DUPLICATE. `save_homework`
  commits before the client invalidates the list.
- **Not reproduced:** both full runs below, and 6 more runs of tests 1, 5 and 6 back to back on the same
  day, all passed (8 runs of test 6 today).
- **Not explained.** It may be a transient refresh or backend failure, or an app-side race in the list
  refresh after a create. I could not tell which. Test 6 now attaches evidence if it fails again: each
  `save_homework` / `list_homework` response (time, status, whether it contains the run's homework) and
  the lesson page text, as "homework not listed" in the Playwright report. Nothing else in test 6 changed.

### Live runs (20 Oct 2026, all specs, serial, Demo School only)

| Run | Result | Duration |
|---|---|---|
| 1 | **94 passed**, 0 failed, 0 skipped | 9.8 min |
| 2 (right after 1) | **94 passed**, 0 failed, 0 skipped | 10.0 min |
| Tests 1 + 5 + 6 of `m2.spec`, 6 times in a row | 18 passed | 0.6–1.4 min each |

`m2.spec` test 2 (period marking on 19 Oct) runs again; it had skipped itself since 20 Oct.
The screenshots the suite rewrites (`docs/reports/m*-screens/`) were restored to their committed versions.
Gates: `typecheck`, `lint`, `test`, `build` ✅.

### Not verified

- A run **on a later day**. Today is 20 Oct, so M2-1's "past start date" branch ran for 19 Oct only (20 Oct
  took the DUPLICATE branch). The 63-day lesson range, the year-end clamp for M2-6 and a holiday Monday have
  only been reasoned about, not run. The server's date can't be faked from the tests.
- After the academic year 2026-27 ends (31 Mar 2027), the fixed dates are in a past year. The specs then
  need new fixed days (and a new mode history) in the new year.

Demo School data added: the usual data of two full runs, plus 6 × (a Class 1 A timetable version from
19 Oct, a diary edit and a checked homework on 20 Oct, a homework on 21 Oct and a version from 21 Oct).
