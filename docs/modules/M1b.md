# M1b — Spreadsheet imports (prompt to paste into Claude Code)

Read `CLAUDE.md`, `docs/reports/M1.md`, PRD **IMPORT-01** + AC-08, TRD **§14.2**, and the whole of
`supabase/migrations/20261005002000_m1b_imports.sql` (the backend for this module — live, tested).
Work on branch `module/m1b-imports` from `main` (which has M1). Quality beats speed. **No backend changes.**
If an RPC is missing or behaves differently from what's written here, stop and tell me.

## What the backend does (read the SQL for details)
- Datasets: `classes_sections`, `staff`, `students_guardians`, `placements`. (Opening fee balances come with Fees/M3;
  `start_import` refuses that dataset.) Capability: `imports.manage`.
- `get_import_template(dataset)` is the **single source of truth** for canonical column keys, labels, required flags,
  examples, allowed values and hints. Never hard-code column lists in the UI.
- Flow: `start_import` (one operation id per upload; replays return the same job; also returns `same_file_before`) →
  `stage_import_rows` (≤500 rows per call, each `{row_no, data:{canonical_key: text}}`; re-staging a row number
  replaces its draft) → preview with `get_import_job` (filters: all/ready/will_skip/needs_fixing/created/skipped/
  rejected/removed; keyset on `row_no`, ≤200 per page; `counts`) → fix with `update_import_row` / remove or restore
  with `set_import_row_removed` → `commit_import_chunk` (≤100 rows per call; call again while `more_ready`) →
  `close_import`. `list_import_jobs` lists history.
- The server parses dates (`YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`), mobiles (strips +91/0/spaces),
  gender (M/F/boy/girl…), yes/no, relationships. Send cell **text**; don't re-validate business rules client-side
  beyond "required column mapped".
- Existing records are **never updated** by import: a matching record → action `skip` ("Already exists — nothing will
  change"). Same key twice in one file → the later row shows "Same record as row N in this file". Siblings with the
  same parent name + mobile share one guardian. Each row commits atomically; a rejected row (e.g. roll number clash)
  can be fixed and retried. Committing again never duplicates anything.

## Build (`src/features/imports/`)
1. **Imports page** (nav item "Imports", capability `imports.manage`): history list (`list_import_jobs`: dataset,
   file name, year, status, counts, who/when) + "New import". Show the recommended order as a short checklist:
   Classes & sections → Staff → Students & parents → Placements (later years). Note "Staff groups must exist first".
2. **New import wizard** (one page, steps):
   1. Choose dataset and academic year (year hidden for staff; defaults to the current year).
   2. **Template**: "Download template" as CSV and XLSX, generated in the browser from `get_import_template`
      (header = labels; second sheet/section with hints + allowed values; example row clearly marked or omitted).
   3. **Upload** CSV or XLSX (≤5 MB, ≤10,000 data rows; refuse bigger with a plain message). Parse in the browser.
      First sheet only for XLSX; first non-empty row is the header. `row_no` = the spreadsheet row number so users
      can find it in their file. Skip fully blank rows. Convert every cell to text: Excel dates → `YYYY-MM-DD` using
      **UTC parts** of the cell date (never local time, never `toISOString()` on a local date); numbers without
      exponent/".0" (a phone 9876543210 must stay `9876543210`); trim.
   4. **Map columns**: auto-match headers to template labels or keys (case/space-insensitive). User can change each
      mapping with a select; unmapped file columns are ignored; every **required** template column must be mapped.
      Show 3 sample values per column.
   5. **Start**: SHA-256 of the file bytes (`crypto.subtle`, hex) as `p_source_fingerprint`; `start_import` with one
      operation id (reuse it on retry); if `same_file_before` is non-empty, warn "This file was imported on <date>.
      Importing again won't create duplicates." Then stage in batches of 500 with a progress bar. On a network error,
      offer "Continue" which re-sends the same batches (safe — re-staging replaces drafts).
3. **Preview** (job page, also reachable from history): count tiles (Ready, Already exist, Needs fixing, Removed,
   Imported, Not imported) — text + colour, never colour only. Filter tabs = server filters. Table: row number, the
   2–4 identifying columns for the dataset, status, error messages next to the field they belong to. Keyset "Load
   more". Row actions: **Edit** (dialog with every template column; `update_import_row`) and **Remove / Restore**.
   Removing a row never deletes a school record — say so in the confirm text.
4. **Import**: button "Import <ready> rows" (disabled when 0). Loop `commit_import_chunk` while `more_ready`, with a
   progress bar and running counts. If a call fails with NETWORK / UNKNOWN / TEMPORARILY_UNAVAILABLE, stop and show
   "Some rows may already be imported — Continue to resume" (calling again is safe). Never say "all imported" unless
   counts prove it; show exact created / already-existed / not-imported / still-needs-fixing numbers.
5. **Results**: created rows link to the new record (student profile / staff profile / setup classes). Rejected rows
   show the reason and can be edited then imported again. **Close import** with a confirm that explains what happens
   to rows not imported (they stay listed with their errors; nothing is deleted). Closed imports are read-only.
6. After any commit, invalidate the setup snapshot, students, staff and guardians queries.

## Rules
- New dependencies allowed, with a one-line reason in the report: **exceljs** (XLSX read/write; TRD names it) and
  **papaparse** (CSV). Both must be **lazy-loaded** inside the imports route only — `check:bundle` must show the
  initial bundle still under the TRD budget (≤300 KB gzip) and the import chunk separate.
- Parsed rows live only in component memory for the wizard; never in browser storage, never in the query cache
  beyond the server responses, never in telemetry. Don't log cell values.
- Query keys include the context revision; the wizard resets on context switch (M0 behaviour).
- All error handling per CLAUDE.md rule 3 and the M1 operation-id rule (`OperationTracker`).

## Done when (record each in `docs/reports/M1b.md`)
- [ ] `typecheck`, `lint`, `test`, `build`, `check:bundle` pass; no `.from(`; no browser storage; initial bundle
      size before/after in the report.
- [ ] Unit tests: XLSX + CSV parsing (Excel date cell → `YYYY-MM-DD` at IST and UTC test time zones, long numbers,
      blank rows, header detection), header auto-mapping, required-column check, batching into ≤500 rows,
      commit loop stops on uncertain error and resumes, template generation from a template response.
- [ ] Playwright, live, Demo School only (unique names per run, e.g. a run suffix):
  1. Classes & sections file (2 classes × 2 sections, one already existing) → preview shows 1 "already exists"
     → import → classes appear in Setup.
  2. Staff file with one unknown staff group and one bad mobile → both flagged → fix the mobile in the Edit dialog,
     remove the other → import → staff appear in the directory.
  3. Students & parents XLSX with two siblings sharing a parent, one roll-number clash, one bad date →
     preview flags the bad date → import → clash row "Not imported" with its reason → edit roll no → import again →
     siblings appear under one guardian (guardian search shows both children).
  4. Re-upload the same students file in a new import → warning about the earlier import → every row "Already
     exists" → importing creates nothing.
  5. Placements file into a second academic year (create it in Setup first) → students placed; the earlier
     year's placement is closed at its year end.
  6. A role without `imports.manage` (Teacher) can't see Imports and gets FORBIDDEN on the route.
- [ ] 375px screenshots: imports history, mapping step, preview with errors, results.
- [ ] Report: every RPC used, mismatches found, anything not verified.

Stop when M1b is done. Don't merge, don't start M2.
