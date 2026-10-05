# PrimeCampus — instructions for coding agents

PrimeCampus is a multi-tenant school operations portal for Indian schools (first school ≈ 800 students).
The **database and backend are finished and live**. Your job is the web app on top of it, one module at a time.

## Source of truth (read before writing code)
| File | What it decides |
|---|---|
| `docs/PrimeCampus_PRD.md` | What the product must do, role rights, acceptance cases AC-01…AC-30 |
| `docs/PrimeCampus_TRD.md` | Architecture, stack, security model, frontend rules |
| `docs/PrimeCampus_DB_Schema.md` | Tables, access matrix, RPC catalog, deviations from the TRD |
| `supabase/migrations/*.sql` | The actual backend. Read the RPC you call before calling it |
| `docs/modules/Mx.md` | Your current module brief — scope, owned files, "done when" |

If the PRD/TRD and the database disagree, **the database wins** and you report the mismatch. Never "fix" it by guessing.

## Stack (TRD §3 — do not substitute)
React 18 + TypeScript (strict) + Vite · React Router (data router, lazy routes) · TanStack Query · React Hook Form + Zod ·
Tailwind CSS + shadcn/ui · `@supabase/supabase-js` v2 · Vitest + React Testing Library + Playwright · npm (commit `package-lock.json`) ·
deploy target: Cloudflare Workers static assets (SPA fallback). No Next.js, no ORM, no Redux, no extra UI kits.
Adding any other dependency needs a one-line justification in your module report.

## Supabase project (public values — safe in the frontend)
```
VITE_SUPABASE_URL=https://ctzjkhmannaoxigirsxu.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_Ay7byY1JoGz5wWIFHKhSpA_cMuODFUH
VITE_LOGIN_EMAIL_DOMAIN=login.vipulpreetham.me
```
Put these in `.env.local` (git-ignored) and `.env.example`. **Never** put a secret/service key anywhere in this repo.
Generate types with `npx supabase gen types typescript --project-id ctzjkhmannaoxigirsxu --schema public > src/generated/database.types.ts`
(needs `SUPABASE_ACCESS_TOKEN`). If you can't, build the typed RPC wrappers by reading the function signatures in the migrations.

## How the backend works — non-negotiable rules
1. **RPC only.** Tables live in `app` / `private` schemas that the API does not expose. The frontend calls
   `supabase.rpc('<name>', {...})` on functions in `public` and nothing else. Never `.from('table')`.
2. **Context revision.** After login the server holds the selected school/role/child. Every school RPC takes
   `p_ctx_rev` (from `select_context` / `get_context`). Exceptions: `bootstrap_account`, `select_context`,
   `end_app_session`, `get_context`, `record_telemetry`, `op_*`.
3. **Errors map on `error.hint`**: `UNAUTHENTICATED` → sign-in · `STALE_CONTEXT` → refetch context, clear caches, show
   "your role/school changed" · `FORBIDDEN` · `VALIDATION_ERROR` (show `message`) · `CONFLICT` (reload record; someone else
   changed it) · `DUPLICATE` · `LIMIT_REACHED` · `NOT_FOUND`. Anything else = "Something went wrong" + request id. Never show SQL.
4. **Idempotency.** Mutations with `p_operation_id` get ONE uuid per user action (create it when the form opens /
   button is first pressed; reuse it on retry). Never auto-retry money, attendance or provisioning with a new id.
5. **Optimistic concurrency.** Pass `p_expected_version` from the row you displayed. On `CONFLICT`, reload and let the user redo.
6. **Money is integer paise** end to end. Format with `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})`
   only at display. Parse rupee input to paise with string math, never floats.
7. **Business dates** are `'YYYY-MM-DD'` strings in Asia/Kolkata. Never derive a date with `toISOString()`.
8. **Missing ≠ zero.** Unmarked attendance, unchecked homework, missing fee price and "no data" each get their own UI state.
   Loading, empty, error, forbidden and offline are different states too. A network failure must never look like ₹0 due or "all present".
9. **Login** (TRD §6): user types a username → client calls `signInWithPassword({ email: `${username}@${VITE_LOGIN_EMAIL_DOMAIN}`, password })`
   → `bootstrap_account` → context chooser → `select_context`. If `must_change_password` is true, the ONLY reachable screen is
   change-password (Edge Function `accounts`, action `change_password`). Never expose the email alias in the UI.
10. **Accounts Edge Function** `accounts` (POST, user JWT): actions `provision`, `reset_password`, `change_password`, `set_status`.
    Temporary passwords are shown once in a dialog, never stored, logged, cached or put in a URL.
11. **Permissions are enforced by the server.** The UI hides what `get_context().capabilities` doesn't include, but must also
    handle `FORBIDDEN` gracefully. Never compute permissions from role names in components; use capabilities.
12. **No school data in localStorage/IndexedDB.** TanStack Query cache is memory-only; query keys include the context
    revision. Switching role/school/child or logging out cancels requests, clears the cache and form drafts, and is broadcast
    to other tabs (BroadcastChannel).
13. **Database changes**: never edit files in `supabase/migrations/` that already exist. If your module brief explicitly allows
    backend work, add a NEW numbered migration, end it with the REVOKE block from `20261005001400_lockdown_grants.sql`,
    and **do not apply it** — list it in your report for the owner to review and apply.

## Repo layout (TRD §5)
```
src/app/            bootstrap, router, layouts, providers
src/components/ui/  shadcn primitives          src/components/shared/  context switcher, tables, form/error wrappers
src/features/<area>/  pages + hooks per module (auth, operator, setup, students, admissions, timetable,
                      attendance, diary, homework, fees, staff, reports)
src/lib/            supabase client, rpc layer, errors, money, dates, operation ids, telemetry
src/contracts/      zod schemas + DTO types for RPC inputs/outputs, query keys, capability names
src/generated/      generated database types (never hand-edit)
tests/              unit, integration, e2e
docs/               specs, module briefs, module reports
```
Components never call `supabase` directly — they use hooks in `src/features/*` that call the typed wrappers in `src/lib/rpc`.

## UI/UX baseline
Responsive: office desktop + teacher/parent phones (test at 375px). Plain English labels. Always-visible current
school / year / role / child. Bulk rosters (attendance, homework) with keyboard support and "mark all present". Clear
saved / unsaved / saving feedback. Color is never the only signal. shadcn defaults, no flashy styling.

## Test data safety
There is ONE Supabase project and a real school will use it. All testing happens inside a school with code `demo`
("Demo School"). Never create, change or delete anything in any other school. Demo usernames start with `demo.`.

## Working rules
- Work only inside your current module's scope (see `docs/modules/`). If something outside it is broken, report it; don't fix it.
- Branch: `module/<id>-<name>`. Small, meaningful commits. Never force-push `main`.
- Ambiguous spec? Stop and ask in one short question. Don't invent product behavior.
- Before saying "done", all of these must pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Finish every module by writing `docs/reports/<id>.md`: what was built, how each "done when" item was verified
  (command / test name / manual steps), screenshots or Playwright traces if UI, known gaps, files touched, any new dependency.
- Do not mark anything done that you haven't verified. Say "not verified" when that's the truth.
