# M0V — Finish verifying M0 before M1 (prompt to paste into Claude Code)

Read `CLAUDE.md`, `docs/reports/M0.md` ("Known gaps / not verified"), `docs/modules/M0.md`, and in the migrations:
`private.bootstrap_account`, `private.select_context`, `private.require_ctx`, `private.disable_membership`,
`private.grant_membership` (1800), `private.svc_password_changed`, `private.svc_set_account_status`,
`private.admit_student`, `private.svc_provision_account`, plus `supabase/functions/accounts/index.ts`.

M0 shipped with three items unverified because Demo School had no data: **parent child cards / multi-role switching**,
the **change-password re-sign-in fallback**, and **CSP + SPA fallback**. This pass verifies them live and also checks the
session edge cases around them. Work on branch `module/m0v-verification` from `main`.

**Scope:** tests, one test-data seed script, and fixes to M0 code that turns out to be wrong. No new screens, no M1
features, **no backend changes** (if the backend behaves differently from what's described here, stop and tell me).

## 1. Seed script — `tests/e2e/fixtures/seed-demo.ts` + `npm run seed:demo`
Signs in as `demo.admin` (password from env `E2E_DEMO_ADMIN_PASSWORD`), selects the Demo School admin context, and uses
**only public RPCs and the `accounts` Edge Function** — never SQL, never a service key.
- Before any write, assert the selected school's code is `demo`; abort otherwise.
- **Idempotent**: look each thing up first and only create what's missing. Running it twice changes nothing.
- Creates in Demo School:
  - Academic year `2026-27` (2026-06-01 → 2027-04-30), set as current.
  - Classes `Class 1`, `Class 2`, each with section `A`.
  - Staff record `Demo TeachParent` (teacher).
  - Students via `admit_student`: **Aarav Demo** (Class 1 A) and **Diya Demo** (Class 2 A) sharing ONE guardian
    **Demo Parent** (the second admission passes `guardian_id`); **Kabir Demo** (Class 1 A) with guardian
    **Demo TeachParent**. `portal_access: true` on all guardian links.
  - Logins via Edge `provision`: `demo.parent` (role parent, `guardian_ids: [Demo Parent]`) and `demo.teachparent`
    (roles teacher + parent, `staff_id` + `guardian_ids: [Demo TeachParent]`).
- **Passwords**: right after provisioning, the script signs in as the new user with the temporary password, calls
  `change_password` to set the password from env (`E2E_PARENT_PASSWORD`, `E2E_TEACHPARENT_PASSWORD`), and signs out.
  The temporary password lives only in a local variable and is **never printed, logged or written to a file**.
  If an account already exists but its password doesn't work, use admin `reset_password` and repeat this.
- Add the new env var names to `.env.example` (names only, no values).

## 2. Live Playwright specs — `tests/e2e/m0v-*.spec.ts` (Demo School only)
1. **Parent with two children (AC-02)**: `demo.parent` signs in → chooser shows two child cards with name +
   class-section → picks Aarav → header shows Aarav. Switches to Diya from the header → `select_context` is called,
   the context revision changes, nothing from Aarav's context remains on screen, and the header shows Diya.
2. **Teacher + Parent (AC-03)**: `demo.teachparent` → chooser lists "Teacher — Demo School" and
   "Parent — Demo School (Kabir Demo)" → enters Teacher → switches to Parent → teacher navigation is gone, parent
   navigation is shown → switches back. Open a second tab first: it follows each switch (BroadcastChannel) and never
   shows the old role's screens.
3. **Role removed while signed in**: `demo.teachparent` is in the Parent context. In a separate browser context the test
   (as `demo.admin`) calls `disable_membership` on that parent membership via the RPC layer. The teachparent tab's next
   action must show a clear message and return to the chooser, which now offers only Teacher. Cleanup: `grant_membership`
   restores the parent role (reuses the existing membership) — confirm with `list_school_users`.
4. **Admin resets a password**: `demo.parent` is signed in. Admin calls Edge `reset_password` for them. The parent's
   next action sends them to sign-in (the server ended their sessions). They sign in with the temporary password, are
   forced to change it, set it back to the env password, and land on the chooser.
5. **Login disabled**: admin calls Edge `set_status` to disable `demo.parent` → the parent's open tab is sent to
   sign-in; signing in again shows the same generic error as a wrong password. Cleanup: re-enable, then sign in works.
6. **Sign-out everywhere still works** with two tabs on different contexts (regression check for M0 test 4).

Every spec must clean up after itself so the suite can run repeatedly, in any order.

## 3. Change-password re-sign-in fallback
Live runs never trigger it, so test it with a component/integration test using a mocked Supabase client:
(a) after `change_password` succeeds, the session is gone → the app signs in again with the new password and continues
to the chooser; (b) that re-sign-in also fails → sign-in page with a clear "Password changed, please sign in" message,
and the new password is not kept anywhere. Also do one live attempt (run spec 4 and log whether the session survived);
report what actually happens.

## 4. CSP and SPA fallback (no deploy)
Run the built app under the Workers runtime locally (`npx wrangler dev` with the existing `wrangler.jsonc`, against
`dist/`). Add `wrangler` as a devDependency if needed and give the one-line reason in the report.
- `curl -I` the root and a deep link (e.g. `/settings/anything`): both return 200 with the `_headers` security headers
  (CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame protection). Paste the headers into the report.
- Run spec 1 against the wrangler URL: no CSP violations in the console, sign-in and RPC calls to
  `ctzjkhmannaoxigirsxu.supabase.co` work, Edge calls work, a page refresh on a deep link loads the app.
- If CSP blocks something, tighten or fix `_headers` with the narrowest rule that works and explain it.

## Done when (record each in `docs/reports/M0V.md`)
- [ ] `npm run seed:demo` run twice: the second run creates nothing (paste both outputs; no passwords in them).
- [ ] Specs 1–6 pass live, run twice in a row. 375px screenshots: parent chooser with two child cards,
      teacher+parent chooser, header with child selected.
- [ ] Re-sign-in fallback tests (a) and (b) pass; live result reported.
- [ ] CSP/SPA checks pass under `wrangler dev`; headers pasted.
- [ ] `typecheck`, `lint`, `test`, `build`, `check:bundle` pass.
- [ ] List every M0 file you changed and why. If nothing needed fixing, say so.

Stop there. Don't merge, don't start M1.
