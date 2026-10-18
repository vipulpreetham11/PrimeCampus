# M1b — Spreadsheet imports: module report

Branch: `module/m1b-imports` · Date: 18 Oct 2026 · Brief: `docs/modules/M1b.md`

## Summary

M1b adds spreadsheet imports on top of M1 (`src/features/imports/`):

- **Imports page** (`/imports`, nav item "Imports", capability `imports.manage`): the recommended order
  (Classes & sections → Staff — staff groups must exist first → Students & parents → Placements) and the import
  history from `list_import_jobs` (dataset, file name, year, status, counts, who/when).
- **New import wizard** (`/imports/new`, one page, five steps): dataset + academic year (hidden for staff, defaults
  to the current year) → template download (XLSX/CSV, built in the browser from `get_import_template`) → upload
  (.xlsx/.csv, ≤ 5 MB, ≤ 10,000 data rows, parsed in a Web Worker) → column mapping (auto-match, a select per
  column, 3 sample values, required columns enforced) → start (`start_import` with a SHA-256 fingerprint and one
  operation id) and staging in batches with a progress bar and "Continue" after a network error.
- **Import page** (`/imports/:jobId`): six count tiles, the eight server filters as tabs, keyset "Load more",
  rows with their identifying columns and errors next to the field they belong to, Edit (every template column)
  and Remove/Restore, "Import N rows" with a progress bar and running counts, "Continue" after an uncertain
  failure, exact results, links to the created records, and Close import. Closed imports are read-only.

No backend files were changed. The owner fixed the four problems found during planning in migration
`20261005002100_m1b_import_fixes.sql` (see "Mismatches"). M2 was not started.

## "Done when" checklist

| # | Item | Status | How it was verified |
|---|---|---|---|
| 1 | `typecheck`, `lint`, `test`, `build`, `check:bundle` pass | ✅ | All five run on the final commit. `test`: 16 files / **250 passed** (190 from M1 + 60 for M1b, after the review fixes). |
| 1b | No `.from(` | ✅ | `grep -rn "\.from(" src tests` (ignoring `Array.from` / `Buffer.from`) finds nothing. E2E test 8 checks every Data API call is `/rest/v1/rpc/<fn>`. |
| 1c | No browser storage | ✅ | `grep -rn "localStorage\|sessionStorage\|indexedDB" src` finds nothing. E2E test 3 checks, after a students import, that neither `localStorage` nor `sessionStorage` holds a student name or parent mobile, and that IndexedDB has no databases. Parsed rows live only in the wizard's component state (never in the query cache). E2E test 8 checks `record_telemetry` bodies carry no cell values. |
| 1d | Initial bundle before / after | ✅ | Measured with the new `check:bundle` (gzip of the JS that `dist/index.html` loads + its static imports). **Before (main): 223.9 KB** (7 files). **After: 226.9 KB** (8 files). Budget 300 KB. exceljs (≈256 KB gzip) and papaparse (≈7 KB gzip) are only in lazy chunks; `check:bundle` fails if either appears in the initial set or has no separate chunk. |
| 2a | Unit: XLSX + CSV parsing | ✅ | `tests/unit/m1b-parse.test.ts`: Excel date cells → `YYYY-MM-DD` under **Asia/Kolkata, UTC and America/Los_Angeles** (and a check that the time-zone switch is real: local getters would give the wrong day in LA); a date-formatted serial (42472) is a date; long numbers (`9876543210`, 15 digits, `1e21`) keep every digit; formula results used; a formula without a result is a blank cell (review fix 1, incl. a hand-built `=IF(1=1,"","x")` sheet); hidden sheets skipped (review fix 5); merged cells; rich text / hyperlinks; header on row 2 after a blank row; a fully blank row skipped with row numbers kept; second sheet ignored; corrupt workbook and empty workbook refused. CSV: BOM, header after blank lines, quoted commas and newlines (row numbers still match the spreadsheet), Windows-1252 fallback only without multi-byte UTF-8, a Telugu name kept intact next to a stray 0x96 byte with the row named (review fix 2), unclosed quote refused with its row, header-only file refused. Limits: exactly 10,000 data rows accepted, 10,001 refused; > 5 MB, `.xls` and empty files refused before reading. |
| 2b | Unit: header auto-mapping | ✅ | `m1b-logic.test.ts` › "header auto-mapping": labels or keys, case/space/underscore-insensitive; a repeated header maps once. |
| 2c | Unit: required-column check | ✅ | "required-column check": lists missing required columns by label; a key chosen twice is flagged. Component test: the start button stays disabled and the message shows. |
| 2d | Unit: batching ≤ 500 rows | ✅ | "batching": 1,201 rows → 500/500/201 in order; batches also stay ≤ 900 KB of JSON; a single huge row still goes alone. |
| 2e | Unit: commit loop stops on uncertain error and resumes | ✅ | "commit loop": loops while `more_ready`; NETWORK / UNKNOWN / TEMPORARILY_UNAVAILABLE stop as "uncertain" and a resumed loop continues; a definite refusal is "failed"; a chunk that processes nothing while `more_ready` stops ("stalled" safety net). Component test: "import: a network error stops with "Continue"…" shows the message, Continue resumes, exact numbers are shown and "all done" is not claimed while a row still needs fixing. |
| 2f | Unit: template generation | ✅ | "template generation": CSV = BOM + one header row of labels with correct quoting; XLSX = "Data" (first sheet, label headers, no example row) + "Help" (required, example, allowed values, hints); the template's headers auto-map back to every column. |
| 2g | Extra component tests | ✅ | `m1b-pages.test.tsx` (12): nav/route access; history; wizard start → stage (fingerprint = SHA-256 of the bytes, `p_academic_year_id` null for staff, same operation id on retry after NETWORK, mapping holds no cell values, "imported before" warning, Continue re-sends the identical batch); `.xls` refused; tiles; errors next to fields; remove confirm text; filter tabs sent as `p_filter`; Import disabled at 0; edit dialog shows every column + server errors and saves the whole row; closed import is read-only and links to the record. |
| 3.1 | Playwright: classes & sections | ✅ live | `tests/e2e/m1b.spec.ts` test 1. Creates `Imp<run> 1` + section A in Setup first. Downloads the XLSX template (checks sheets Data/Help, header = labels, no data row). CSV with 2 classes × 2 sections → tiles Ready 3 / Already exist 1, row 2 "Already exists — nothing will change" → Import 3 rows → "3 imported, 1 already existed" and "All rows in this import are done." → "Open classes in Setup" → both classes show sections A and B. |
| 3.2 | Playwright: staff (375px) | ✅ live | Test 2, at 375px. Headers in other cases (`EMPLOYEE NO`, `full name`) auto-map. Unknown group → `No active staff group named "No such group <run>". Create it first.`; bad mobile → "Mobile: Use a 10-digit mobile number". Fix the mobile in Edit (row becomes Ready); Remove the other (confirm says removing never deletes a school record) → Import 2 rows → Imported 2, Removed 1 → both staff in the directory, the removed one not. |
| 3.3 | Playwright: students & parents XLSX | ✅ live | Test 3. XLSX built with real Excel date cells. Bad date (31/02/2019) flagged under Date of birth; an Excel date cell arrived as `2019-05-01`. The bad date is fixed in Edit. Import 4 rows → "3 imported … 1 not imported"; the clash row shows "Not imported" + "Roll number already used in this section…" → Edit roll no → Import 1 row → Imported 4, "All rows … done". "Open student" opens the profile with the parent. Admit page guardian search: **one** result for the shared parent, listing both sibling names. Storage check (row 1c). |
| 3.4 | Playwright: re-upload the same file | ✅ live (see note) | Test 4. Same bytes → "This file was imported on … Importing again won't create duplicates." Rows 2–4: "Already exists — nothing will change". **Row 5 is "Needs fixing", not "Already exists":** the file still has the invalid date 31/02/2019, and the server validates a row before matching it (mismatch 2). "Confirm 3 existing rows" → "0 imported, 3 already existed (nothing changed)". Then Close import (confirm text checked) → read-only, "Closed — some rows not imported". The student search still shows exactly 4 students for the run. |
| 3.5 | Playwright: placements into a second year | ✅ live | Test 5. Creates 2027-28 (1 Apr 2027 – 31 Mar 2028, not current) in Setup if missing; imports its Class 1 A section (classes & sections into 2027-28); placements CSV → 2 Ready, 1 "No student with this admission number. Import students first." → Import 2 rows. Profile class history: "2027-28: Class 1 A · Roll …, 1 Apr 2027 – now" and the 2026-27 row now ends "1 Apr 2026 – 31 Mar 2027" (stored `effective_to` 2027-04-01 is exclusive; the profile shows the last day — review fix 11). |
| 3.6 | Playwright: Teacher has no Imports | ✅ live | Test 6. `demo.teacher`: no "Imports" link; `/imports` and `/imports/new` show "You don't have access to this page". Server: `list_import_jobs` and `get_import_template` as the Teacher return `FORBIDDEN`. |
| 4 | 375px screenshots | ✅ | `docs/reports/m1b-screens/`: `375-imports-history.png`, `375-mapping-step.png`, `375-preview-with-errors.png`, `375-results.png`. Each test asserts no horizontal scroll at 375px. As in M1, the fixed bottom bar appears mid-image in full-page captures (Playwright stitching). |
| 5 | Report: RPCs, mismatches, not verified | ✅ | Below. |

### Live runs

The full live suite (M0 6 + M1 12 + M1b 8) passed **twice in a row, 26/26**, against the live project, in the
Demo School only (6.3 and 6.0 minutes). The second run took the "already exists" paths for 2027-28 and its
Class 1 A section. Before that, two M1b-only runs failed on test selectors (not app bugs): at 375px the staff
directory shows a list instead of the table, and the edit dialog had two buttons named "Close" (the footer one is
now "Cancel"). The M1b-only suite then passed 8/8. The M0/M1 screenshots the suite rewrites were restored to
their committed versions. Afterwards the M1b suite ran once more, 8/8, after a test-only change: the screenshot
helper hides toasts and scrolls to the top so no toast covers the results screen. `m1b-screens/` comes from that run.

## Review fixes

Done after the owner's review (18 Oct). All five commands pass (16 files / **250 tests**). The full live suite was run
once afterwards: **26/26** (M0 6 + M1 12 + M1b 8, 6.0 min). `m1b-screens/` were refreshed by that run; the M0/M1
screenshots were restored to their committed versions.

1. **Formulas whose result is an empty string.** ExcelJS 4.4 returns `{formula}` with no result both for
   `=IF(…,"",…)` / `=IFERROR(…,"")` (Excel writes `t="str"` + empty `<v>`) and for a formula never calculated (no
   `<v>`). Checked by loading both shapes: identical. They can't be told apart, so neither refuses the file any
   more; both import as a blank cell (the server flags a blank required value on that row). Test:
   `m1b-parse.test.ts` › "hand-built sheet: =IF(1=1,"","x")…" (XML patched with `jszip` to exactly what Excel writes).
2. **CSV encoding.** Valid UTF-8 → as is. Invalid UTF-8 that still contains valid multi-byte sequences → UTF-8
   non-fatally (U+FFFD only at the bad bytes) plus a warning before upload naming the rows with "�". Windows-1252 only
   when there is no valid multi-byte UTF-8 at all. Tests: "a Telugu name plus one stray 0x96 byte…" (name intact,
   row 3 named), "falls back to Windows-1252 only when…", and the wizard test "a CSV with one unreadable byte shows
   which rows to check".
3. **Import run state.** The run (state, latest commit response) now lives in `ImportJobPage` above the data states;
   after the first load the page is never replaced by an error panel — a failed refresh shows "This import couldn't
   be refreshed… may be out of date" + Try again, and the "Some rows may already be imported — Continue" warning
   stays. `useImportJob` uses `keepPreviousData` (switching filters keeps the page; the old rows are dimmed and
   disabled until the new ones load). During a run the filter tabs, Edit, Remove/Restore, Load more and Close
   import are disabled. Tiles and the run result use the newer of the page's job and the latest commit response
   (`outcome.job.counts`). Tests: "outage: commit AND the background refresh fail…" (`get_import_job` fails from the
   first failed commit to the end; the warning survives, and after Continue the numbers come from the commit
   response while the page copy is stale) and "while a run is in progress: … disabled".
4. **Wording.** Only existing rows left and nothing to fix: "These rows already exist. Confirming re-checks them;
   anything missing now will be created." (with rows to fix, the same plus "Rows that need fixing are left out").
   The stall message is now "No rows were processed. Reload the import and try again." with a Reload button.
   Tests: "only existing rows left…", "a chunk that processes nothing…".
5. **Hidden sheets** are skipped: the first visible sheet is read; a workbook with none is refused. Test: "skips
   hidden sheets…" (hidden + very hidden before the data sheet).
6. **Parent mobile alias.** In Students & parents, a header that is exactly "Mobile", "Phone" or "Contact" maps to
   Parent 1 mobile (`guardian1_phone`); "Student mobile" still maps to the student's. Staff is unchanged. Test:
   "students & parents: a bare "Mobile" / "Phone" / "Contact" header…".
7. **Rows with data only in unmapped columns** are not staged; step 5 says "N rows had no data in the mapped columns
   and were skipped (rows …)" before upload, and the counts/progress use the staged rows. Tests:
   "rows with values only in unmapped columns are not staged…" (logic) and the wizard test that checks
   `stage_import_rows` receives only row 2.
8. **Staff-groups queries** (`staff-groups`, `staff-groups-finance`) are invalidated after any commit.
9. **`pending` row status** is accepted by the contract (the table allows it; no RPC sets it today) and shown as
   "Being imported" (not editable). Test: "pending rows … parse and show as "Being imported"".
10. **Capability on the job page.** "Import N rows" is disabled when the role lacks the dataset's capability
    (`setup.manage` / `staff.manage` / `students.manage`, same rule as the wizard), with "Your role can't import
    <dataset>…". Test: "a role without the dataset capability (staff.manage)…".
11. **Placement dates on the student profile** show `addDays(to, −1)` (the stored `effective_to` is exclusive).
    E2E test 5 now expects "1 Apr 2026 – 31 Mar 2027" — verified live. Not unit-tested (no M1 profile fixture).
12. **E2E Demo School guard.** Every sign-in in `m1b.spec.ts` (`asUser`, used by every test) asserts the header
    (`context-summary`) shows "Demo School" before doing anything.

## RPCs used by M1b

All through the generated wrappers (`src/lib/rpc/functions.ts`, regenerated: 116 wrappers); every response is
validated by the zod schemas in `src/contracts/imports.ts` (registered in `RPC_RESULT_SCHEMAS`).

| RPC | Used for | Live (E2E) |
|---|---|---|
| `get_import_template` | template download, mapping targets, edit dialog | yes |
| `start_import` | one per upload; operation id from `OperationTracker` | yes |
| `stage_import_rows` | ≤ 500 rows / ≤ 900 KB per call | yes |
| `get_import_job` | preview/results, 8 filters, keyset on `row_no` (100 per page) | yes |
| `update_import_row` | Edit dialog | yes |
| `set_import_row_removed` | Remove / Restore | Remove yes, Restore unit only |
| `commit_import_chunk` | Import loop (100 per call while `more_ready`) | yes |
| `close_import` | Close import | yes |
| `list_import_jobs` | history | yes |

Also used: `get_setup_snapshot` (years for the year select), `save_class`, `save_section`, `save_academic_year`
(test set-up through the M1 screens).

## Mismatches found

1. **Found in planning, fixed by the owner in migration 2100** (built against the fixed behaviour):
   `counts.rejected` was always 0 (rejected rows carry an error, so they were counted as `needs_fixing`);
   `commit_import_chunk` could stop progressing when ≥ 100 in-file duplicates came first; a replayed `start_import`
   didn't return `same_file_before`. The client keeps its "chunk processed nothing" guard as a safety net.
2. **Re-importing a file with an invalid value doesn't show that row as "Already exists".** `imp_validate` reports
   field errors even when the record exists, so on re-upload such a row is "Needs fixing" (test 4, row 5). Brief
   test 4 says "every row Already exists"; that holds only for rows whose values are valid. Not changed.
3. **Placement end date display (M1 screen) — fixed in review fix 11.** `effective_to` is exclusive; the profile
   showed it as the last day ("1 Apr 2026 – 1 Apr 2027"). It now shows `to − 1 day` ("… – 31 Mar 2027").
4. **Generated type:** `start_import.p_academic_year_id` is typed `string`, but staff imports send `null`
   (the SQL accepts it). One cast in `startImportJob`, approved by the owner.
5. **Import button when only existing rows remain.** The brief says "Import <ready> rows (disabled when 0)", but
   brief test 4 needs to "import" a file whose rows all exist. The button reads "Import N rows" when rows are ready,
   "Confirm N existing rows" when only existing rows are left (the server marks them skipped; nothing changes), and
   is disabled only when neither kind is left.
6. **"Already exist" tile** = `will_skip + skipped` (before and after confirming), so the number is stable across
   the import. The filter tabs keep the two apart ("Already exist" vs "Skipped (already existed)").

## Design notes

- **Parsing** runs in a module Web Worker (`parse.worker.ts`) that lazy-loads exceljs/papaparse; where a worker
  can't start, the same code runs on the main thread. Everything becomes text: Excel dates via UTC parts, numbers
  without exponent/".0", rich text/hyperlinks as text, formula results (a formula without a result is blank — see
  review fix 1), only the first visible sheet, merged cells only in their top-left cell, error values (`#N/A`) as text so the server flags the row.
- **Templates:** XLSX "Data" sheet columns are text-formatted (so Excel won't turn `2024/001` into a date); required
  columns carry a "Required" note. The CSV template is the header row only; its help is shown on screen.
- **Operation ids:** `start_import` uses `OperationTracker` (same id after NETWORK/UNKNOWN/TEMPORARILY_UNAVAILABLE,
  new id after success, a definite refusal, or a changed file/mapping). Staging and commit need no ids
  (re-staging replaces drafts; committing again never duplicates).
- **Invalidation:** after any commit: the job, the history, `setup`, `students`, `student`, `staff-list`, `staff`,
  `staff-groups`, `staff-groups-finance`, `guardian`, `guardian-search`.
- **Context switch:** the wizard is reset by M0's `RootLayout` (keyed by the session epoch); query keys carry the
  context revision.
- Leaving the wizard mid-upload asks first (`useBlocker` + `beforeunload`).
- The row edit dialog's footer button is "Cancel" (the dialog's ✕ is already "Close").

## Known gaps / not verified

- **Not exercised live:** Continue after a staging or commit network failure (unit + component tests only);
  Restore of a removed row; the "no rows processed" guard; "Load more" (no job had more than 100 rows); the
  main-thread parsing fallback (jsdom only); Windows-1252 and lossy UTF-8 CSVs; hidden sheets; empty-string formula
  results; the parent-mobile alias; skipped empty rows; the disabled Import for a role without the dataset
  capability; the leave-mid-upload confirmation (not tested at all). All except the last are unit/component tested.
- **Large files:** a 10,000-row / 5 MB file was not run live (only the row-limit logic is unit-tested), so worker
  parse time and upload time at that size are not measured.
- **Partly uploaded imports:** if someone leaves during staging, the import holds only the rows sent so far; the
  server has no "expected row count", so the import page can't warn that rows are missing.
- **Real school spreadsheets:** none were available (PRD §20 asks for anonymized samples before live imports);
  mapping was tested with the templates' own labels and with differently-cased headers only.
- Keyboard-only and screen-reader walkthroughs were not done.
- Opening fee balances are out of scope (Fees/M3).

## Demo School data after the runs

All created through the UI, in Demo School only. Each full run adds, with a run suffix:
2 classes `Imp<run> 1/2` (sections A, B in 2026-27), 2 staff `IMP<run>-1/3`, 4 students `IMP<run>-1…4`
(Class 1 A, 2026-27) with 3 guardians (two siblings share one), placements of 2 of them in 2027-28, and
5 import jobs. Created once and reused: academic year **2027-28** (not current) and its **Class 1 A** section.
Two earlier partial runs (`CM8TS`, `COQ75`, failing on test selectors) also left their classes and staff, and
one students import (`students-COQ75.xlsx`) still "In preview" with nothing committed.

## Files touched

- **Generated:** `src/generated/database.types.ts` (+9 import functions), `src/lib/rpc/functions.ts` (116 wrappers).
- **Contracts:** `src/contracts/imports.ts` (new), `src/contracts/rpc-results.ts`.
- **Feature:** `src/features/imports/` — `ImportsPage.tsx`, `NewImportPage.tsx`, `ImportJobPage.tsx`,
  `RowEditDialog.tsx`, `parts.tsx`, `hooks.ts`, `labels.ts`, `mapping.ts`, `batching.ts`, `runners.ts`,
  `template.ts`, `fingerprint.ts`, `parse/{sheet,cells,xlsx,csv,index,libs,client,parse.worker}.ts`.
- **Shared:** `src/components/shared/ProgressBar.tsx` (new).
- **App:** `src/app/router.tsx` (guarded `/imports` routes), `src/app/navigation.ts` + `src/app/layouts/AppShell.tsx`
  (Imports nav item + icon).
- **Build:** `vite.config.ts` (`worker.format: 'es'`; raw chunk warning 1000 KB for the lazy exceljs chunk),
  `scripts/check-bundle.mjs` (initial gzip budget + lazy-library checks), `package.json`, `package-lock.json`.
- **M1 file (review fix 11):** `src/features/students/StudentProfilePage.tsx` (placement end date).
- **Tests:** `tests/unit/m1b-{parse,logic}.test.ts`, `tests/unit/m1b-pages.test.tsx`, `tests/unit/m1b-fixtures.ts`,
  `tests/e2e/m1b.spec.ts`.
- **Docs:** this report, `docs/reports/m1b-screens/*.png`.

**New dependencies**
- `exceljs@4.4.0`: XLSX read (upload) and write (template); named by the TRD. Lazy-loaded in the imports
  route/worker only.
- `papaparse@5.7.0`: CSV parsing (quoted fields, newlines in cells, delimiter detection). Lazy-loaded likewise.
- `@types/papaparse` (dev): its types.
- `jszip@3.10.2` (dev, review fix 1): the unit test hand-builds the XLSX XML Excel writes for `=IF(1=1,"","x")`.
  Same version exceljs already installs (deduped, no new code in the app).

**Backend:** no migrations or Edge Function changes.
