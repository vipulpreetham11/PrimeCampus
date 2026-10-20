# How PrimeCampus was built: from idea to code

This is a write-up of the method used to build PrimeCampus, a multi-tenant school ERP for Indian schools (the first school has about 800 students). It was built by one founder working with two AIs:

- **Claude in chat** acted as architect, backend engineer and reviewer.
- **Claude Code** was the coding agent that built the frontend.

The method is the useful part. It can be reused for the next product.

---

## 1. The core idea in one paragraph

**The documents are the memory, not the chat.** Every decision lives in a file in the repo: the product spec, the tech spec, the database schema, a brief for each module and a report for each module. Any AI session, new or old, starts by reading those files. That is what made a large build possible with AI agents that forget everything between sessions.

Three other principles came with it:

1. **Backend first, and finished.** The whole database and server logic was written and tested before any screen was built.
2. **One module at a time,** each with a written brief and a written report.
3. **Separate the builder from the reviewer.** The agent that writes the code never approves its own work.

---

## 2. The phases

### Phase 0: Research (before writing any spec)
Output: `school-erp-competitive-research.md`, `sis-deep-dive.md`, `fee-module-deep-dive.md`

- Studied the existing Indian school ERPs: what they do, where they fail, what schools actually complain about.
- Did a deep dive on the two areas that matter most and break most often: **student records (SIS)** and **fees**.
- Practical knowledge came from real school operations (the family runs schools), not just from websites.

**Technique:** research the domain hard before writing requirements. A fee module designed without knowing about cheque bounces, concessions, opening balances from the old system and parents paying partly in cash will be rewritten later.

### Phase 1: Product spec (PRD)
Output: `PrimeCampus_PRD.md` (`primecampus-v1-prd.md`)

- **Scope cut on purpose:** V1 has setup, people, imports, timetable, attendance, diary, homework, fees, salary, reports, dashboards and an operator console. Exams and report cards were **explicitly deferred** (PRD §2.2) so V1 could ship.
- Each feature has an ID (TIME-02, ATT-03, FEE-06, SAL-01…) so briefs and reports can point at exact requirements.
- **Role rights** were written down per role: operator, admin, principal, accountant, owner, teacher, parent, student.
- **Acceptance cases AC-01…AC-30** describe concrete situations that must work. Later, these became live tests.
- There's a page inventory and a definition of every dashboard.

**Technique:** write the "won't do" list as carefully as the "will do" list. Give every requirement an ID.

### Phase 2: Technical spec (TRD)
Output: `PrimeCampus_TRD.md`

Main decisions:

- **Stack:** React 18 + TypeScript + Vite, TanStack Query, React Hook Form + Zod, Tailwind + shadcn/ui, Supabase (Postgres, Auth, Edge Functions), hosted on Cloudflare Workers. The stack is fixed: agents may not swap libraries.
- **RPC only:** the frontend never touches tables. All tables live in schemas the API doesn't expose, and the app calls only `public` functions.
- **Login by username:** the username is turned into a hidden email alias. Temporary passwords are shown once and never stored.
- **Server-side context:** after login, the server holds the selected school, role and child, and every call carries a context revision. Switching role clears every cache.
- **Rules written as law:** money is integer paise; dates are `YYYY-MM-DD` in Asia/Kolkata; "missing" never looks like "zero"; mutations carry an idempotency key; edits carry a version number.

**Technique:** turn every lesson from past projects into a written rule. Agents follow written rules well and unwritten taste badly.

### Phase 3: Database schema and backend (built completely before any UI)
Output: `PrimeCampus_DB_Schema.md`, and migrations `0100` → `1500`, then about 15 more as modules needed them

- About 30 SQL migrations, each one numbered and never edited after it went live.
- Layers:
  - Tables in `app` / `private`.
  - `SECURITY DEFINER` functions in `private` with `search_path=''`.
  - Thin wrappers in `public`.
  - A final "lockdown" block in every migration that revokes everything that isn't explicitly granted.
- **Capabilities, not role names:** the code checks `fees.manage`, `attendance.read_all` and so on. Roles map to capabilities in one place.
- **One error contract:** every error comes back with a code (`UNAUTHENTICATED`, `STALE_CONTEXT`, `FORBIDDEN`, `VALIDATION_ERROR`, `CONFLICT`, `DUPLICATE`, `LIMIT_REACHED`, `NOT_FOUND`), a plain-English message and, when relevant, the field it belongs to. The UI maps codes, never SQL text.
- **Idempotency and audit built in:** a repeated payment or a double-click returns the first result (`replayed: true`) instead of creating a duplicate. Every write is logged.

**How the backend was tested:**
- A local Postgres 16 harness rebuilds the whole database from the migrations (`run_all.sh`).
- Python scenario scripts call the functions as real users (admin, teacher, parent…) and check results and error codes.
- At the end there were 120 core scenarios, a concurrency test (two cashiers can't over-collect, and receipt numbers stay unique) and one test script per migration (95 checks for fees, 63 for salary and reports, and so on).
- **Rehearsal:** each migration was packaged as a `RUN_IN_SQL_EDITOR_xxxx.sql` file and run first on a copy of the database built without that migration. Only then did the owner run it on the live database.
- Performance was checked on the live database with read-only `EXPLAIN ANALYZE`. That is how the salary-month timeout was found and fixed (from 1.3–2.6 s per call down to about 75 ms).

### Phase 4: Agent rulebook (`CLAUDE.md`)
This is a single file at the repo root that every coding agent reads first. It contains:

- Which document decides what: PRD, TRD, schema, migrations, current module brief. **"If the spec and the database disagree, the database wins, and you report it."**
- The fixed stack and the public Supabase values. Secret keys are never in the repo.
- 13 non-negotiable backend rules (RPC only, context revision, error codes, idempotency, versions, paise, dates, missing ≠ zero, login flow, server-enforced permissions, no school data in browser storage, never edit live migrations).
- Repo layout, UI baseline (works at 375 px, plain English, colour never the only signal).
- **Test-data safety:** all testing happens in "Demo School" (code `demo`). Nothing in any other school is ever touched.
- **Definition of done:** typecheck, lint, test and build all pass, plus a written report that says "not verified" honestly.

### Phase 5: Building module by module
| Module | What it covered |
|---|---|
| M0 | Foundation: login, context chooser, role switching, error handling, layout |
| M1 | Setup & people: school, years, classes, sections, subjects, staff, students, guardians |
| M1b | Spreadsheet imports (Excel/CSV, staged → validated → committed, safe to re-run) |
| M2 | Timetable, attendance (day-wise and period-wise), diary, homework |
| M2X | Close-out: verify everything from M0–M2 live and finish the known gaps |
| M3 | Fees: structures, invoices, concessions, collections, cheques, dues, opening balances |
| M4 | Salary, reports, lesson changes, dashboards, operator console |

---

## 3. The per-module loop

```
Claude (chat) writes the backend migration for the module + its tests
        ↓
Owner runs RUN_IN_SQL_EDITOR_xxxx.sql in Supabase, commits the migration
        ↓
Claude writes the module brief  docs/modules/<id>.md
        ↓
Claude Code reads CLAUDE.md + brief + earlier reports → shows its PLAN
        ↓
Claude checks the plan (missing RPCs? wrong assumptions?) → backend additions if needed
        ↓
Claude Code builds → unit tests → live Playwright tests in Demo School → report docs/reports/<id>.md
        ↓
Claude reviews: clones the branch, runs all gates, reads the code, checks the live DB
        ↓
ONE fix round (prompt written by Claude) → re-check
        ↓
Owner merges:  git merge --no-ff module/<id>-<name>
```

Rules that kept the loop clean:

- **No backend changes by the coding agent.** If an RPC is missing, it stops and reports. The backend is only changed by a reviewed, tested migration.
- **One module at a time;** the next branch starts only after the previous one is merged.
- **A new agent chat per module.** The repo carries the context, not the chat history.
- **Never run git in another window while the agent works** (this caused a stash clash once).
- **A close-out module (M2X)** after the first three modules, whose only job was turning every "not verified" item into ✅ or ❌-with-reason.

---

## 4. How a module brief is written

Every brief has the same shape (see `docs/modules/M4.md`):

1. **Read first:** the exact PRD sections, acceptance cases, TRD sections and migration files.
2. **Branch name and scope fence:** "No backend changes — if an RPC is missing or behaves differently, stop and tell me."
3. **Capabilities used:** listed by name, never by role.
4. **Build:** one section per area. Each names the exact RPC with its parameters and the exact UI states (for example, "blank = unmarked, not absent"; "say 'Already saved — no new version'").
5. **Rules:** money and dates, missing ≠ zero, which shared helpers to use.
6. **Done when:** a checklist covering the gates, the unit tests, numbered live Playwright scenarios (in Demo School, unique names per run), "full live suite passes twice in a row", 375 px screenshots, and a report listing every RPC used, any mismatches, and what was not verified.
7. **"Stop when done. Don't merge."**

### Prompt template: start a module
```
Read CLAUDE.md, docs/modules/<ID>.md and the latest docs/reports/.
Branch module/<id>-<name> from main. Show me your plan first:
pages, hooks, which RPC each screen calls, tests you will write,
and anything in the brief that doesn't match the migrations.
Don't write code until I approve the plan.
```

### Prompt template: fix round after review
```
<ID> fix round on module/<id>-<name>. Migration <xxxx> is now live (read its header).
No other backend changes.
1. <finding> — expected behaviour, and the test that proves it.
2. <flake> — find the real cause from the trace/logs; don't just raise timeouts.
3. Live-verify: <list>. Each ends ✅ or ❌ with reason.
4. Gates, then full live suite twice in a row. Update docs/reports/<ID>.md. Push. Don't merge.
```

### Prompt template: stop spending
```
Stop after the current run. Don't start another run, whatever the result.
Record infra failures (outage/timeout) in the report as such.
Finish the report, commit, push, stop.
```

---

## 5. Review techniques that caught real bugs

- **Review the code, not the report.** Clone the branch, run typecheck, lint, test, build and the bundle check yourself, and read the risky files.
- **Check the plan against the database before building.** This turned up missing fields early. For example, M4's plan led to migration 2410, which added who calculated a salary, teacher-absent flags and audit actor names.
- **Query the live database (read-only) to test hypotheses.** For example, "is the missing homework a paging problem?" was ruled out by checking that there are at most 21 rows per section per date.
- **Look for the real cause of a flaky test.** The "homework not appearing" flake happened 3 times. The cause turned out to be a TanStack Query behaviour: invalidating a query that has no data yet reuses the request already in flight, so the save's refetch never happened. The cause was found from the API logs, reproduced on purpose with a deliberately slowed request, and fixed once for every list in the app.
- **Write tests that encode the rules:** idempotent replay, stale version → CONFLICT, two cashiers at once can't over-collect, a missing price is never invoiced as ₹0, unmarked ≠ absent.
- **"Not verified" is an allowed answer, and hiding it isn't.** Every report has that section, and the close-out module exists to empty it.

---

## 6. Safety rules that never bent

- No secret or service keys in the repo or frontend; only public values in `.env.local`.
- Temporary passwords are shown once and never stored, logged, cached or put in a URL.
- E2E passwords live only in environment variables or the git-ignored `.env.local`.
- Testing only in Demo School, with `demo.` usernames.
- Migrations written by an agent are never applied without review. Live migrations are never edited, only followed by a new one.
- `RUN_IN_SQL_EDITOR` files are never committed.
- Never `npm audit fix --force`. Dependency issues are fixed with targeted overrides plus proof that nothing broke.
- The repo stays public during development and is made private before launch.

---

## 7. What it cost and what we'd do differently

- **Full live suites are expensive.** About 109 tests at roughly 25 minutes per run, repeated across fix rounds, used up a lot of agent credits. Next time:
  - run only the affected module's specs during fix rounds;
  - run the full suite twice once, just before the merge;
  - don't rerun because of a platform outage.
- **Free-plan Supabase** occasionally has statement timeouts and outages that look like test failures. The report should label them as infrastructure, not code.
- **Writing the backend first was the best decision.** Frontend agents had a fixed, tested contract to build against, and most review findings were UI or test issues, not data bugs.
- **Real-data testing should happen earlier.** Testing with the school's real spreadsheets was postponed until before onboarding. Doing it in M1b would have exposed the slow import step sooner.

---

## 8. Status and what's next
- M0, M1, M1b, M2, M2X and M3 are merged. M4 is in its final fix round.
- Next:
  - deploy to Cloudflare Workers on the custom domain, and make the repo private;
  - run one real-data test pass with the school's actual spreadsheets;
  - onboard the first school.
- V2: exams and report cards.
