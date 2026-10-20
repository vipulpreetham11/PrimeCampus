import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { scheduleLessonSchema } from '@/contracts/timetable';
import { contextSchema } from '@/contracts/session';
import { sessionStore } from '@/lib/session/store';
import { contextRow, fakeSupabase, ids, onRpc, resetFake, rpcCalls } from './fake-supabase';
import { classSubjectsM2, M2, snapshotM2 } from './m2-fixtures';
import { feeSetupRow, snapshotM3 } from './m3-fixtures';
import {
  auditEvent,
  CAPS,
  changeRow,
  computation,
  coverageRow,
  dashboardFor,
  feeHeadReport,
  M4,
  maintenanceRow,
  monthRow,
  paidLeaveRow,
  registerRow,
  salaryMonth,
  savedSnapshot,
  versionRow,
} from './m4-fixtures';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { SalaryMonthPage } = await import('@/features/salary/SalaryMonthPage');
const { SalaryStaffPage } = await import('@/features/salary/SalaryStaffPage');
const { RegisterPage } = await import('@/features/attendance/register/RegisterPage');
const { AttendanceChangesPage } = await import('@/features/attendance/register/ChangesPage');
const { CoveragePage } = await import('@/features/reports/CoveragePage');
const { FeeHeadsPage } = await import('@/features/reports/FeeHeadsPage');
const { LessonActions } = await import('@/features/schedule/LessonActions');
const { ExtraLessonDialog } = await import('@/features/schedule/ExtraLessonDialog');
const { DashboardPage } = await import('@/features/dashboard/DashboardPage');
const { ActivityLogPage, MaintenancePage } = await import('@/features/operator/ConsolePages');

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const hinted = (hint: string, message: string, details: unknown = '') => ({
  error: {
    code: 'P0001',
    hint,
    message,
    details: typeof details === 'string' ? details : JSON.stringify(details),
  },
});

function setCtx(caps: string[], role: string, isOperator = false) {
  sessionStore.reset();
  sessionStore.set({
    status: 'ready',
    account: { accountId: ids.account, username: 'demo.x', displayName: 'Demo', isOperator },
    context: contextSchema.parse({ ...contextRow(1, role, caps), staff_id: null }),
  });
}

function renderAt(path: string, routes: { path: string; element: ReactElement }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([...routes, { path: '*', element: <p>other page</p> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { qc, router };
}

beforeEach(() => {
  resetFake();
});

// ============================================================================ salary
describe('salary calculator (manager)', () => {
  const staffPath = `/salary/${M4.staff}?month=2026-09`;
  const staffRoute = [{ path: '/salary/:staffId', element: <SalaryStaffPage /> }];

  function reads(
    save?: (n: number) => unknown,
    preview: (args: Record<string, unknown>) => unknown = () => ({ data: computation() }),
  ) {
    let saves = 0;
    onRpc((fn, args) => {
      if (fn === 'get_salary_month') return { data: salaryMonth([monthRow()]) };
      if (fn === 'preview_salary') return preview(args ?? {}) as { data: unknown };
      if (fn === 'get_salary_calculations') return { data: [] };
      if (fn === 'list_paid_leave') return { data: [paidLeaveRow()] };
      if (fn === 'save_salary_calculation') return (save?.(++saves) ?? { data: null }) as { data: unknown };
      return { data: null };
    });
  }

  beforeEach(() => setCtx(CAPS.admin, 'admin'));

  it('shows the formula with real numbers, marked days, unmarked dates with links and discrepancies in words', async () => {
    reads();
    renderAt(staffPath, staffRoute);
    expect(await screen.findByTestId('salary-formula')).toHaveTextContent(
      '₹40,000.00 × (15 + 1) / 20 = ₹32,000.00',
    );
    expect(screen.getByTestId('marked-days')).toHaveTextContent(
      'present 14 · late 0 · half day 2 · absent 2 · unmarked 2',
    );
    const unmarked = screen.getByTestId('unmarked-dates');
    expect(within(unmarked).getByRole('link', { name: 'Tue 29 Sept' })).toHaveAttribute(
      'href',
      `/staff-attendance?date=2026-09-29&group=${M4.group}`,
    );
    expect(screen.getByTestId('discrepancies')).toHaveTextContent('non-working day — it is not counted');
    expect(screen.getByText('Ramesh Peon', { exact: false })).toBeInTheDocument();
    // paid leave of the month is listed
    expect(await screen.findByTestId('paid-leave')).toHaveTextContent('Family function');
  });

  it('Save → "Saved as version 1"; saving again unchanged → "Already saved — no new version"', async () => {
    reads((n) => ({
      data: {
        ...computation(),
        salary_calculation_id: M4.calc,
        version_no: 1,
        ...(n > 1 ? { replayed: true } : {}),
      },
    }));
    renderAt(staffPath, staffRoute);
    const save = await screen.findByRole('button', { name: 'Save calculation' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByTestId('salary-save-result')).toHaveTextContent('Saved as version 1.');
    expect(calls('save_salary_calculation')[0]!.args).toEqual({
      p_staff_id: M4.staff,
      p_month: '2026-09-01',
      p_ctx_rev: 1,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save calculation' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save calculation' }));
    expect(
      await screen.findByText('Already saved — no new version (version 1 is unchanged).'),
    ).toBeInTheDocument();
  });

  it('overrides: validated under the field, need a reason, preview then save sends them', async () => {
    reads(
      () => ({
        data: {
          ...computation({ attended_days: 16, payable_paise: 3_400_000 }),
          salary_calculation_id: M4.calc,
          version_no: 2,
        },
      }),
      (args) => ({
        data: args.p_overrides
          ? computation({ attended_days: 16, payable_paise: 3_400_000, overrides: args.p_overrides })
          : computation(),
      }),
    );
    renderAt(staffPath, staffRoute);
    await userEvent.click(await screen.findByRole('button', { name: 'Override values' }));
    const attended = screen.getByLabelText('Attended days (0–31, steps of 0.5)');
    await userEvent.type(attended, '15.3');
    await userEvent.click(screen.getByRole('button', { name: 'Preview with these values' }));
    expect(await screen.findByText('Days must be 0–31 in steps of 0.5')).toBeInTheDocument();
    expect(attended).toHaveAttribute('aria-invalid', 'true');

    await userEvent.clear(attended);
    await userEvent.type(attended, '16');
    await userEvent.click(screen.getByRole('button', { name: 'Preview with these values' }));
    expect(await screen.findByText('Overrides need a reason')).toBeInTheDocument();
    expect(calls('preview_salary').some((c) => c.args?.p_overrides)).toBe(false);
    // Save is blocked while the form differs from what was previewed
    expect(screen.getByText('Preview the changed values before saving.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save calculation' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason for the overrides'), 'Worked on a holiday');
    await userEvent.click(screen.getByRole('button', { name: 'Preview with these values' }));
    expect(await screen.findByText('₹40,000.00 × (16 + 1) / 20 = ₹34,000.00')).toBeInTheDocument();
    expect(screen.getByText('(override)', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save calculation' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save calculation' }));
    await screen.findByText('Saved as version 2.');
    expect(calls('save_salary_calculation')[0]!.args).toMatchObject({
      p_overrides: { attended_days: 16 },
      p_override_reason: 'Worked on a holiday',
    });
  });

  it("the server's field error is shown under that field", async () => {
    reads(() =>
      hinted('VALIDATION_ERROR', 'Monthly salary must be whole paise, ₹0 or more', {
        field: 'monthly_salary_paise',
      }),
    );
    renderAt(staffPath, staffRoute);
    const save = await screen.findByRole('button', { name: 'Save calculation' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText('Monthly salary must be whole paise, ₹0 or more')).toBeInTheDocument();
    expect(screen.getByLabelText('Monthly salary (₹)')).toHaveAttribute('aria-invalid', 'true');
  });

  it('needs manual resolution: explained, and Save stays disabled', async () => {
    reads(undefined, () => ({
      data: computation({
        monthly_salary_paise: null,
        payable_paise: null,
        needs_manual_resolution: true,
        resolution_reason: 'No salary rate recorded',
      }),
    }));
    renderAt(staffPath, staffRoute);
    expect(await screen.findByText("Can't calculate yet: No salary rate recorded.")).toBeInTheDocument();
    expect(screen.getAllByText('No salary rate').length).toBeGreaterThan(0);
    expect(screen.getByTestId('salary-formula')).toHaveTextContent('No payable amount yet');
    expect(screen.getByRole('button', { name: 'Save calculation' })).toBeDisabled();
  });

  it('a lost reply says "Not confirmed" (saving again is safe)', async () => {
    reads(() => ({ error: { message: 'TypeError: Failed to fetch' } }));
    renderAt(staffPath, staffRoute);
    const save = await screen.findByRole('button', { name: 'Save calculation' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByTestId('unconfirmed')).toHaveTextContent('Saving again is safe');
  });
});

describe('after a save the status is never the old "Changed since saved"', () => {
  it('save and replay show "Saved vN" at once, while the month is still being asked again', async () => {
    setCtx(CAPS.admin, 'admin');
    let monthCalls = 0;
    let saves = 0;
    onRpc((fn) => {
      if (fn === 'get_salary_month') {
        monthCalls += 1;
        // first load: saved v1 but changed since; every later refetch hangs (the server is slow)
        if (monthCalls === 1)
          return {
            data: salaryMonth([monthRow({ status: 'changed', saved: savedSnapshot() })], true, {
              saved: 1,
              changed: 1,
              not_saved: 0,
            }),
          };
        return new Promise(() => undefined);
      }
      if (fn === 'preview_salary')
        return { data: computation({ attended_days: 16, payable_paise: 3_400_000 }) };
      if (fn === 'get_salary_calculations') return { data: [] };
      if (fn === 'list_paid_leave') return { data: [] };
      if (fn === 'save_salary_calculation') {
        saves += 1;
        return {
          data: {
            ...computation({ attended_days: 16, payable_paise: 3_400_000 }),
            salary_calculation_id: M4.calc2,
            version_no: 2,
            ...(saves > 1 ? { replayed: true } : {}),
          },
        };
      }
      return { data: null };
    });
    renderAt(`/salary/${M4.staff}?month=2026-09`, [
      { path: '/salary/:staffId', element: <SalaryStaffPage /> },
    ]);
    expect(await screen.findByTestId('salary-status')).toHaveTextContent('Changed since saved');
    const save = await screen.findByRole('button', { name: 'Save calculation' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await screen.findByText('Saved as version 2.');
    expect(screen.getByTestId('salary-status')).toHaveTextContent('Saved v2');
    expect(screen.queryByText(/changed after version/)).not.toBeInTheDocument();
    expect(monthCalls).toBeGreaterThan(1); // the refetch was asked and is still pending
    // the replay keeps it
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save calculation' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save calculation' }));
    await screen.findByText('Already saved — no new version (version 2 is unchanged).');
    expect(screen.getByTestId('salary-status')).toHaveTextContent('Saved v2');
  });
});

describe('salary for readers (Owner)', () => {
  beforeEach(() => setCtx(CAPS.owner, 'owner'));

  it('sees the saved result and the status, no calculator and no buttons', async () => {
    onRpc((fn) => {
      if (fn === 'get_salary_month')
        return {
          data: salaryMonth([monthRow({ status: 'changed', saved: savedSnapshot(), live: null })], false, {
            saved: 1,
            changed: 1,
            not_saved: 0,
            saved_payable_paise: 3_200_000,
          }),
        };
      if (fn === 'get_salary_calculations') return { data: [versionRow()] };
      if (fn === 'list_paid_leave') return { data: [] };
      return { data: null };
    });
    renderAt(`/salary/${M4.staff}?month=2026-09`, [
      { path: '/salary/:staffId', element: <SalaryStaffPage /> },
    ]);
    expect(await screen.findByTestId('saved-result')).toHaveTextContent(
      '₹40,000.00 × (15 + 1) / 20 = ₹32,000.00',
    );
    expect(screen.getByTestId('salary-status')).toHaveTextContent('Changed since saved');
    expect(await screen.findByTestId('salary-version')).toHaveTextContent(
      'Saved 1 Oct 2026, 10:30 am by Demo Admin',
    );
    expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add paid leave' })).not.toBeInTheDocument();
    expect(calls('preview_salary')).toHaveLength(0);
  });

  it('month view: saved results only, no live column', async () => {
    onRpc((fn) => {
      if (fn === 'get_salary_month')
        return {
          data: salaryMonth(
            [
              monthRow({ status: 'saved', saved: savedSnapshot(), live: null }),
              monthRow({ staff_id: M4.staff2, name: 'Lata Iyer', status: 'not_saved', live: null }),
            ],
            false,
            { saved: 1, not_saved: 1, saved_payable_paise: 3_200_000 },
          ),
        };
      if (fn === 'list_staff_groups') return { data: [] };
      return { data: null };
    });
    renderAt('/salary?month=2026-09', [{ path: '/salary', element: <SalaryMonthPage /> }]);
    const table = await screen.findByTestId('salary-table');
    expect(within(table).queryByText('Payable now')).not.toBeInTheDocument();
    const rows = within(table).getAllByTestId('salary-row');
    expect(within(rows[0]!).getByTestId('salary-status')).toHaveTextContent('Saved v1');
    expect(within(rows[1]!).getByTestId('salary-status')).toHaveTextContent('Not calculated');
    expect(within(rows[1]!).getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByTestId('total-saved-payable')).toHaveTextContent('₹32,000.00');
  });
});

describe('salary month view (manager)', () => {
  it('status chips for every state; saved vs live payable; unmarked count', async () => {
    setCtx(CAPS.admin, 'admin');
    onRpc((fn) => {
      if (fn === 'get_salary_month')
        return {
          data: salaryMonth(
            [
              monthRow({ name: 'A Not saved' }),
              monthRow({
                staff_id: M4.staff2,
                name: 'B Saved',
                status: 'saved',
                saved: savedSnapshot({ version_no: 2 }),
              }),
              monthRow({
                staff_id: M4.group,
                name: 'C Changed',
                status: 'changed',
                saved: savedSnapshot(),
                live: liveFrom(3_100_000),
              }),
              monthRow({
                staff_id: M4.calc,
                name: 'D Resolve',
                status: 'needs_resolution',
                partial_month: true,
                live: liveFrom(null, {
                  needs_manual_resolution: true,
                  resolution_reason: 'No salary rate recorded',
                  monthly_salary_paise: null,
                }),
              }),
            ],
            true,
          ),
        };
      if (fn === 'list_staff_groups') return { data: [] };
      return { data: null };
    });
    renderAt('/salary?month=2026-09', [{ path: '/salary', element: <SalaryMonthPage /> }]);
    const table = await screen.findByTestId('salary-table');
    expect(
      within(table)
        .getAllByTestId('salary-status')
        .map((c) => c.textContent),
    ).toEqual(['Not calculated', 'Saved v2', 'Changed since saved', 'Needs manual resolution']);
    const changed = within(table).getAllByTestId('salary-row')[2]!;
    expect(changed).toHaveTextContent('₹32,000.00');
    expect(changed).toHaveTextContent('₹31,000.00');
    expect(within(table).getAllByTestId('salary-row')[3]!).toHaveTextContent("Can't calculate");
    expect(within(table).getAllByText('2 unmarked').length).toBeGreaterThan(0);
    expect(within(table).getByText('Partial month')).toBeInTheDocument();
  });
});

function liveFrom(payable: number | null, o: Record<string, unknown> = {}) {
  return {
    monthly_salary_paise: 4_000_000,
    working_days: 20,
    attended_days: 15,
    paid_leave_days: 1,
    unpaid_days: 4,
    payable_paise: payable,
    marked_days: { present: 14, late: 0, half_day: 2, absent: 2 },
    needs_manual_resolution: false,
    resolution_reason: null,
    unmarked_count: 2,
    discrepancy_count: 0,
    ...o,
  };
}

// ============================================================================ register
describe('attendance register', () => {
  const path = `/attendance/register?section=${M4.section}&month=2026-10`;
  const route = [{ path: '/attendance/register', element: <RegisterPage /> }];

  it('unmarked ≠ absent, period attended/held with incomplete marker, provisional totals', async () => {
    setCtx(CAPS.principal, 'principal');
    onRpc((fn) => {
      if (fn === 'get_attendance_register') return { data: registerRow() };
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      return { data: null };
    });
    renderAt(path, route);
    const grid = await screen.findByTestId('register-grid');
    const cells = within(grid).getAllByTestId('register-cell');
    const cell = (row: number, date: string) =>
      cells.filter((c) => c.getAttribute('data-date') === date)[row]!;
    expect(cell(0, '2026-10-20')).toHaveAttribute('data-state', 'unmarked');
    expect(cell(0, '2026-10-20')).toHaveTextContent('Not marked');
    expect(cell(1, '2026-10-20')).toHaveAttribute('data-state', 'A');
    expect(cell(1, '2026-10-20')).toHaveTextContent('Absent');
    expect(cell(0, '2026-10-19')).toHaveTextContent('2/3*');
    expect(cell(1, '2026-10-19')).toHaveTextContent('Not in this section');
    expect(cell(0, '2026-10-18')).toHaveAttribute('data-state', 'non_working');
    expect(
      within(grid)
        .getAllByTestId('register-final')
        .map((b) => b.textContent),
    ).toEqual(['Provisional', 'Final']);
    expect(screen.getByTestId('register-legend')).toHaveTextContent('blank = not marked');
    // phone layout: a card per student with the month summary
    expect(within(screen.getByTestId('register-phone')).getAllByTestId('register-student')).toHaveLength(2);
    expect(calls('get_attendance_register')[0]!.args).toEqual({
      p_section_id: M4.section,
      p_month: '2026-10-01',
      p_ctx_rev: 1,
    });
  });

  it("another teacher's section: the server's FORBIDDEN is shown as no access", async () => {
    setCtx(CAPS.teacher, 'teacher');
    onRpc((fn) => {
      if (fn === 'get_attendance_register')
        return hinted('FORBIDDEN', 'Only the class teacher, Principal or Admin can see this register');
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      return { data: null };
    });
    renderAt(path, route);
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument();
    expect(
      screen.getByText('Only the class teacher, Principal or Admin can see this register'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('register-grid')).not.toBeInTheDocument();
  });
});

describe('attendance changes', () => {
  it('lists old → new with the actor and pages with the change-id cursor', async () => {
    setCtx(CAPS.principal, 'principal');
    onRpc((fn, args) => {
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      if (fn === 'list_attendance_changes') {
        if (args?.p_before_id === undefined)
          return {
            data: { items: Array.from({ length: 50 }, (_, i) => changeRow(1000 - i)), next_cursor: 951 },
          };
        return {
          data: { items: [changeRow(950, { old_status: null, new_status: 'L' })], next_cursor: null },
        };
      }
      return { data: null };
    });
    renderAt('/attendance/changes?from=2026-10-01&to=2026-10-20', [
      { path: '/attendance/changes', element: <AttendanceChangesPage /> },
    ]);
    const list = await screen.findByTestId('attendance-changes');
    expect(within(list).getAllByTestId('attendance-change')).toHaveLength(50);
    expect(within(list).getAllByTestId('change-statuses')[0]!).toHaveTextContent(
      'Absent → changed to Present',
    );
    expect(within(list).getAllByTestId('change-actor')[0]!).toHaveTextContent(
      'Changed by Demo Admin (Admin)',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('attendance-change')).toHaveLength(51));
    expect(calls('list_attendance_changes')[1]!.args).toMatchObject({ p_before_id: 951, p_kind: 'student' });
    expect(screen.getAllByTestId('change-statuses')[50]!).toHaveTextContent('Not marked → changed to Late');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

// ============================================================================ coverage + fee heads
describe('academic coverage', () => {
  it('shows Unassigned rows, diary x / y and totals = sum of rows', async () => {
    setCtx(CAPS.principal, 'principal');
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      if (fn === 'get_academic_coverage')
        return {
          data: {
            from: '2026-09-21',
            to: '2026-10-20',
            rows: [
              coverageRow(),
              coverageRow({
                subject: 'Maths',
                subject_id: M2.maths,
                staff_id: null,
                teacher: 'Unassigned',
                lessons: 4,
                diary_written: 1,
              }),
            ],
            note: 'Lessons = scheduled (not cancelled) lessons up to today.',
          },
        };
      return { data: null };
    });
    renderAt('/reports/coverage', [{ path: '/reports/coverage', element: <CoveragePage /> }]);
    const table = await screen.findByTestId('coverage-table');
    const rows = within(table).getAllByTestId('coverage-row');
    expect(rows[0]!).toHaveTextContent('Ravi Kumar');
    expect(rows[0]!).toHaveTextContent('7 / 10');
    expect(rows[1]!).toHaveTextContent('Unassigned');
    expect(within(table).getByText('Total (2 rows)').closest('tr')).toHaveTextContent('8 / 14');
    const args = calls('get_academic_coverage')[0]!.args!;
    expect(Object.keys(args).sort()).toEqual(['p_ctx_rev', 'p_from', 'p_to']);
  });
});

describe('fee-head totals', () => {
  it("per head net, totals and the server's note", async () => {
    setCtx(CAPS.accountant, 'accountant');
    onRpc((fn) => {
      if (fn === 'get_fee_setup') return { data: feeSetupRow() };
      if (fn === 'get_setup_snapshot') return { data: snapshotM3() };
      if (fn === 'get_fee_head_report') return { data: feeHeadReport() };
      return { data: null };
    });
    renderAt('/fees/reports/heads', [{ path: '/fees/reports/heads', element: <FeeHeadsPage /> }]);
    expect(await screen.findByTestId('heads-charged')).toHaveTextContent('₹9,650.00');
    expect(screen.getByTestId('heads-paid')).toHaveTextContent('₹4,000.00');
    expect(screen.getByTestId('heads-balance')).toHaveTextContent('₹5,650.00');
    expect(screen.getAllByTestId('fee-head-row')[0]!).toHaveTextContent('₹9,350.00');
    expect(screen.getByText('Adjustments not linked to a head')).toBeInTheDocument();
    expect(screen.getByTestId('heads-net-total')).toHaveTextContent('₹9,650.00');
    expect(screen.getByText(/collections are shown in total only/)).toBeInTheDocument();
  });
});

// ============================================================================ lessons (TIME-02)
const lesson = scheduleLessonSchema.parse({
  lesson_session_id: 41,
  section_id: M2.sectionA,
  section: 'Class 1 A',
  slot_ordinal: 1,
  slot_label: 'Period 1',
  start_time: '09:00:00',
  end_time: '09:40:00',
  subject: 'English',
  subject_id: M2.english,
  planned_staff_id: M2.ravi,
  planned_staff: 'Ravi Kumar',
  actual_staff_id: M2.ravi,
  actual_staff: 'Ravi Kumar',
  status: 'scheduled',
  cancel_reason: null,
  version: 3,
  source: 'timetable',
  actual_teacher_absent: null,
  planned_teacher_absent: null,
  planned_teacher_half_day: null,
  has_diary: false,
  homework_count: 0,
  is_substituted: false,
  unassigned: false,
});

describe('change time', () => {
  it('sends the version and new times; an overlap refusal is shown as sent', async () => {
    setCtx(CAPS.admin, 'admin');
    onRpc((fn) => {
      if (fn === 'update_lesson_session')
        return hinted('VALIDATION_ERROR', 'That time overlaps Mathematics (Period 2) for this section');
      return { data: null };
    });
    renderAt('/', [{ path: '/', element: <LessonActions lesson={lesson} date="2026-10-23" /> }]);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Period 1, English' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Change time' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Starts at'), { target: { value: '09:30' } });
    fireEvent.change(within(dialog).getByLabelText('Ends at'), { target: { value: '10:10' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change time' }));
    expect(
      await within(dialog).findByText('That time overlaps Mathematics (Period 2) for this section'),
    ).toBeInTheDocument();
    expect(calls('update_lesson_session')[0]!.args).toEqual({
      p_lesson_session_id: 41,
      p_action: 'change_time',
      p_expected_version: 3,
      p_start_time: '09:30',
      p_end_time: '10:10',
      p_ctx_rev: 1,
    });
  });

  it('an end before the start is refused before sending', async () => {
    setCtx(CAPS.admin, 'admin');
    renderAt('/', [{ path: '/', element: <LessonActions lesson={lesson} date="2026-10-23" /> }]);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Period 1, English' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Change time' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Ends at'), { target: { value: '08:30' } });
    expect(within(dialog).getByText('The end time must be later than the start time')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Change time' })).toBeDisabled();
  });
});

describe('extra lesson', () => {
  it('DUPLICATE → "Already added" with a link to open the existing lesson', async () => {
    setCtx(CAPS.admin, 'admin');
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      if (fn === 'list_class_subjects') return { data: classSubjectsM2() };
      if (fn === 'list_staff') return { data: [] };
      if (fn === 'add_extra_lesson')
        return hinted('DUPLICATE', 'This extra lesson already exists', { lesson_session_id: 77 });
      return { data: null };
    });
    renderAt('/', [
      {
        path: '/',
        element: <ExtraLessonDialog date="2026-10-23" sectionId={M2.sectionA} onClose={() => undefined} />,
      },
    ]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Starts at'), { target: { value: '15:00' } });
    fireEvent.change(within(dialog).getByLabelText('Ends at'), { target: { value: '15:40' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Subject')).toBeEnabled());
    await userEvent.click(within(dialog).getByLabelText('Subject'));
    await userEvent.click(await screen.findByRole('option', { name: 'English' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add extra lesson' }));
    const exists = await within(dialog).findByTestId('extra-exists');
    expect(exists).toHaveTextContent('Already added');
    expect(within(exists).getByRole('link', { name: 'Open it' })).toHaveAttribute('href', '/lessons/77');
    expect(calls('add_extra_lesson')[0]!.args).toEqual({
      p_section_id: M2.sectionA,
      p_date: '2026-10-23',
      p_start_time: '15:00',
      p_end_time: '15:40',
      p_subject_id: M2.english,
      p_ctx_rev: 1,
    });
  });

  it('the per-date limit (~12 extra lessons per section and date) shows the server message', async () => {
    setCtx(CAPS.admin, 'admin');
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
      if (fn === 'list_class_subjects') return { data: classSubjectsM2() };
      if (fn === 'list_staff') return { data: [] };
      if (fn === 'add_extra_lesson') return hinted('LIMIT_REACHED', 'Too many lessons on this date');
      return { data: null };
    });
    renderAt('/', [
      {
        path: '/',
        element: <ExtraLessonDialog date="2026-10-23" sectionId={M2.sectionA} onClose={() => undefined} />,
      },
    ]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Starts at'), { target: { value: '15:00' } });
    fireEvent.change(within(dialog).getByLabelText('Ends at'), { target: { value: '15:40' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Subject')).toBeEnabled());
    await userEvent.click(within(dialog).getByLabelText('Subject'));
    await userEvent.click(await screen.findByRole('option', { name: 'English' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add extra lesson' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too many lessons on this date');
    expect(within(dialog).queryByTestId('extra-exists')).not.toBeInTheDocument();
    expect(calls('add_extra_lesson')).toHaveLength(1); // a definite refusal is not re-sent
  });
});

// ============================================================================ dashboards
describe('dashboards per capability', () => {
  const route = [{ path: '/dashboard', element: <DashboardPage /> }];
  const blocks = () =>
    ['attendance', 'staff', 'academic', 'admissions', 'fees', 'salary', 'setup'].filter((b) =>
      screen.queryByTestId(`block-${b}`),
    );

  function serve(role: 'admin' | 'principal' | 'accountant' | 'owner') {
    onRpc((fn) => (fn === 'get_dashboard' ? { data: dashboardFor(role) } : { data: null }));
  }

  it('Admin: every block; numbers link to the detail pages with the same rules', async () => {
    setCtx(CAPS.admin, 'admin');
    serve('admin');
    renderAt('/dashboard', route);
    await screen.findByTestId('block-attendance');
    expect(blocks()).toEqual(['attendance', 'staff', 'academic', 'admissions', 'fees', 'salary', 'setup']);
    expect(screen.getByTestId('num-diary-missing')).toHaveAttribute(
      'href',
      '/diary?from=2026-10-13&to=2026-10-19&missing=1',
    );
    expect(screen.getByTestId('num-homework-unchecked')).toHaveAttribute(
      'href',
      '/homework?due_unchecked=1&from=2026-10-06&to=2026-10-20',
    );
    expect(screen.getByTestId('num-uncovered')).toHaveAttribute(
      'href',
      '/schedule?date=2026-10-20&uncovered=1',
    );
    expect(screen.getByTestId('num-collected')).toHaveTextContent('₹4,500.00');
    expect(screen.getByTestId('num-collected')).toHaveAttribute(
      'href',
      '/fees/day-book?from=2026-10-20&to=2026-10-20',
    );
    expect(screen.queryByTestId('num-older-dues')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('block-setup')).getByRole('link', { name: 'Fix in Timetable' }),
    ).toHaveAttribute('href', `/timetable?section=${M4.section}`);
  });

  it('Principal: attendance, staff and academic only (+ coverage and register links)', async () => {
    setCtx(CAPS.principal, 'principal');
    serve('principal');
    renderAt('/dashboard', route);
    await screen.findByTestId('block-attendance');
    expect(blocks()).toEqual(['attendance', 'staff', 'academic']);
    expect(screen.getByRole('link', { name: 'Academic coverage' })).toHaveAttribute(
      'href',
      '/reports/coverage',
    );
    expect(screen.getByRole('link', { name: 'Attendance register' })).toBeInTheDocument();
  });

  it('Accountant: fees only, with Collect payment / Day book / Dues / Cheques', async () => {
    setCtx(CAPS.accountant, 'accountant');
    serve('accountant');
    renderAt('/dashboard', route);
    await screen.findByTestId('block-fees');
    expect(blocks()).toEqual(['fees']);
    for (const name of ['Collect payment', 'Day book', 'Dues', 'Cheques'])
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
  });

  it('Owner: fees, salary and attendance, read-only; earlier-year dues shown separately', async () => {
    setCtx(CAPS.owner, 'owner');
    onRpc((fn) => {
      if (fn !== 'get_dashboard') return { data: null };
      const d = dashboardFor('owner') as { fees: Record<string, unknown> };
      return { data: { ...d, fees: { ...d.fees, older_years_due_paise: 125_000 } } };
    });
    renderAt('/dashboard', route);
    await screen.findByTestId('block-fees');
    expect(blocks()).toEqual(['attendance', 'fees', 'salary']);
    expect(screen.getByTestId('num-older-dues')).toHaveTextContent('₹1,250.00');
    expect(screen.getByTestId('num-salary-payable')).toHaveAttribute('href', '/salary?month=2026-09');
    expect(screen.queryByRole('link', { name: 'Collect payment' })).not.toBeInTheDocument();
  });

  it('Teacher: the Today page, not the dashboard RPC', async () => {
    setCtx(CAPS.teacher, 'teacher');
    onRpc((fn) =>
      fn === 'get_teacher_today'
        ? {
            data: {
              date: '2026-10-20',
              mode: 'daily',
              lessons: [],
              class_teacher_sections: [],
              homework_to_check: [],
            },
          }
        : { data: null },
    );
    renderAt('/dashboard', route);
    expect(await screen.findByText('No lessons for you on this day.')).toBeInTheDocument();
    expect(calls('get_dashboard')).toHaveLength(0);
  });

  it('a failed load is an error, never ₹0 or 0', async () => {
    setCtx(CAPS.accountant, 'accountant');
    onRpc(() => ({ error: { message: 'TypeError: Failed to fetch' } }));
    renderAt('/dashboard', route);
    expect(await screen.findByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
    expect(screen.queryByTestId('block-fees')).not.toBeInTheDocument();
  });
});

// ============================================================================ operator
describe('operator console', () => {
  it('no access (and no operator RPC) for a non-operator account', async () => {
    setCtx(CAPS.admin, 'admin', false);
    renderAt('/operator/activity', [{ path: '/operator/activity', element: <ActivityLogPage /> }]);
    expect(screen.getByText("You don't have access to this")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcCalls.filter((c) => c.fn.startsWith('op_'))).toHaveLength(0);
  });

  it('activity log: actor name, username and role, via-Operator flag, expandable detail', async () => {
    setCtx(CAPS.admin, 'admin', true);
    onRpc((fn) => {
      if (fn === 'op_list_schools') return { data: [] };
      if (fn === 'op_get_audit_events')
        return { data: { items: [auditEvent(5, { via_operator: true })], next_before_id: null } };
      return { data: null };
    });
    renderAt('/operator/activity', [{ path: '/operator/activity', element: <ActivityLogPage /> }]);
    const row = await screen.findByTestId('audit-event');
    expect(row).toHaveTextContent('salary.calculation.saved');
    expect(within(row).getByTestId('audit-actor')).toHaveTextContent(
      'Demo Admin (demo.admin) · Admin · Demo School',
    );
    expect(within(row).getByText('Via Operator')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Show details' }));
    expect(within(row).getByText(/"payable_paise": 3200000/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('maintenance: schedule in IST, runs, and Run now after confirming', async () => {
    setCtx(CAPS.admin, 'admin', true);
    onRpc((fn) => {
      if (fn === 'op_get_maintenance') return { data: maintenanceRow() };
      if (fn === 'op_run_retention_cleanup')
        return {
          data: { telemetry_deleted: 2, usage_daily_deleted: 0, auth_events_deleted: 1, sessions_expired: 3 },
        };
      return { data: null };
    });
    renderAt('/operator/maintenance', [{ path: '/operator/maintenance', element: <MaintenancePage /> }]);
    expect(await screen.findByTestId('maintenance-schedule')).toHaveTextContent('Daily at 02:30 IST');
    expect(screen.getByTestId('maintenance-runs')).toHaveTextContent('1 idle sessions ended');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByTestId('cleanup-result')).toHaveTextContent('3 idle sessions ended');
    expect(calls('op_run_retention_cleanup')).toHaveLength(1);
  });
});
