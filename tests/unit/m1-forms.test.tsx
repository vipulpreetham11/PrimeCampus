import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { fakeSupabase, ids, onRpc, resetFake, rpcCalls, setupSnapshotRow } from './fake-supabase';
import { renderPage, setContext } from './render';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { StaffFinanceCard } = await import('@/features/staff/StaffFinanceCard');
const { StaffProfilePage } = await import('@/features/staff/StaffProfilePage');
const { StaffGroupsPage } = await import('@/features/staff/StaffGroupsPage');
const { MovePlacementsDialog } = await import('@/features/students/MovePlacementsDialog');
const { SchoolProfilePage } = await import('@/features/setup/SchoolProfilePage');
const { setupSnapshotSchema } = await import('@/contracts/setup');

const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const SECTION_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLASS_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECTION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);

function staffRecord(finance: boolean) {
  return {
    staff_id: STAFF_ID,
    employee_no: 'DEMO-T1',
    full_name: 'Demo Teacher',
    gender: null,
    phone: null,
    email: null,
    staff_group_id: ids.school,
    group: 'Teaching staff',
    designation: 'TGT',
    is_teaching: true,
    joined_on: '2026-06-01',
    left_on: null,
    status: 'active',
    has_login: false,
    version: 3,
    login: null,
    can: { edit: false, finance, link_login: false },
  };
}

function snapshotWithSections() {
  return {
    ...setupSnapshotRow(),
    classes: [{ id: CLASS_1, name: 'Class 1', sort_order: 1, status: 'active', version: 1 }],
    sections: [
      {
        id: SECTION_A,
        academic_year_id: ids.year,
        class_id: CLASS_1,
        name: 'A',
        capacity: 40,
        sort_order: 0,
        status: 'active',
        version: 1,
      },
      {
        id: SECTION_B,
        academic_year_id: ids.year,
        class_id: CLASS_1,
        name: 'B',
        capacity: null,
        sort_order: 1,
        status: 'active',
        version: 1,
      },
    ],
  };
}

beforeEach(() => resetFake());

// ------------------------------------------------------------------ money input for salary
describe('staff salary uses MoneyInput → integer paise', () => {
  beforeEach(() => setContext(['staff.read', 'staff_finance.read', 'staff_finance.manage']));

  it('typing “40,000.50” saves 4000050 paise', async () => {
    onRpc((fn) => {
      if (fn === 'get_staff_confidential') return { data: { salary_rates: [], bank: null } };
      if (fn === 'save_staff_finance') return { data: { staff_id: STAFF_ID } };
      return { data: null };
    });
    renderPage(<StaffFinanceCard staffId={STAFF_ID} />);
    const input = await screen.findByLabelText('New monthly salary');
    await userEvent.type(input, '40,000.50');
    await userEvent.click(screen.getByRole('button', { name: 'Add salary rate' }));
    await waitFor(() => expect(calls('save_staff_finance')).toHaveLength(1));
    expect(calls('save_staff_finance')[0]!.args).toMatchObject({
      p_staff_id: STAFF_ID,
      p_monthly_salary_paise: 4000050,
      p_ctx_rev: 1,
    });
    expect(Number.isInteger(calls('save_staff_finance')[0]!.args!.p_monthly_salary_paise)).toBe(true);
  });

  it('rejects 3 decimal places with a visible message and does not save', async () => {
    onRpc((fn) =>
      fn === 'get_staff_confidential' ? { data: { salary_rates: [], bank: null } } : { data: null },
    );
    renderPage(<StaffFinanceCard staffId={STAFF_ID} />);
    await userEvent.type(await screen.findByLabelText('New monthly salary'), '40000.555');
    expect(screen.getByText(/at most 2 decimal places/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add salary rate' }));
    expect(calls('save_staff_finance')).toHaveLength(0);
  });

  it('shows salary history as rupees from paise', async () => {
    onRpc(() => ({
      data: {
        salary_rates: [{ monthly_salary_paise: 4000000, effective_from: '2026-06-01', reason: null }],
        bank: null,
      },
    }));
    renderPage(<StaffFinanceCard staffId={STAFF_ID} />);
    expect(await screen.findByText('₹40,000.00')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ finance hidden without capability
describe('finance / confidential UI is hidden without the capability', () => {
  function handler(finance: boolean) {
    return (fn: string) => {
      if (fn === 'get_staff') return { data: staffRecord(finance) };
      if (fn === 'get_staff_confidential') return { data: { salary_rates: [], bank: null } };
      if (fn === 'list_teaching_assignments' || fn === 'list_staff') return { data: [] };
      if (fn === 'list_staff_groups')
        return {
          data: [
            {
              id: ids.school,
              name: 'Teaching staff',
              status: 'active',
              version: 1,
              staff_count: 2,
              default_monthly_salary_paise: finance ? 3000000 : null,
            },
          ],
        };
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      return { data: null };
    };
  }

  it('teacher (no staff_finance.read): no salary card, no confidential request, no salary column', async () => {
    setContext(['staff.member', 'staff.read', 'timetable.read_all'], 'teacher');
    onRpc(handler(false));
    renderPage(<StaffProfilePage />, { path: `/staff/${STAFF_ID}`, route: '/staff/:staffId' });
    expect(await screen.findByTestId('staff-name')).toHaveTextContent('Demo Teacher');
    expect(screen.queryByTestId('staff-finance-card')).toBeNull();
    expect(screen.queryByText(/Salary & bank/)).toBeNull();
    expect(calls('get_staff_confidential')).toHaveLength(0);
  });

  it('teacher: staff groups list has no salary column', async () => {
    setContext(['staff.member', 'staff.read'], 'teacher');
    onRpc(handler(false));
    renderPage(<StaffGroupsPage />);
    expect(await screen.findByTestId('group-row-Teaching staff')).toBeInTheDocument();
    expect(screen.queryByText('Default monthly salary')).toBeNull();
    expect(screen.queryByTestId('group-salary')).toBeNull();
  });

  it('with staff_finance.read: the card and the salary column appear', async () => {
    setContext(['staff.member', 'staff.read', 'staff_finance.read'], 'owner');
    onRpc(handler(true));
    renderPage(<StaffProfilePage />, { path: `/staff/${STAFF_ID}`, route: '/staff/:staffId' });
    expect(await screen.findByTestId('staff-finance-card')).toBeInTheDocument();
    await waitFor(() => expect(calls('get_staff_confidential')).toHaveLength(1));
    // read-only: no edit forms without staff_finance.manage
    expect(screen.queryByRole('button', { name: 'Add salary rate' })).toBeNull();
  });
});

// ------------------------------------------------------------------ placement move: one operation id
describe('placement move preview → commit', () => {
  it('uses the same operation id for preview and commit', async () => {
    setContext(['students.manage', 'students.read_all']);
    const student = {
      student_id: ids.child1,
      name: 'Aarav Demo',
      admission_no: 'DEMO-001',
      status: 'active' as const,
      class: 'Class 1',
      section: 'A',
      section_id: SECTION_A,
      roll_no: '1',
    };
    const row = {
      student_id: ids.child1,
      from_section_id: SECTION_A,
      to_section_id: SECTION_B,
      roll_no: null,
      errors: [],
      class_changes: false,
      fee_note: 'Existing invoices are not recalculated',
      marks_after_move_in_old_section: 0,
    };
    onRpc((fn, args) =>
      fn === 'move_placements'
        ? args?.p_preview
          ? { data: { preview: true, can_apply: true, rows: [row] } }
          : { data: { preview: false, batch_id: ids.membership, moved: 1, rows: [row] } }
        : { data: null },
    );
    const onDone = vi.fn();
    renderPage(
      <MovePlacementsDialog
        students={[student]}
        snapshot={setupSnapshotSchema.parse(snapshotWithSections())}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />,
    );
    await userEvent.click(screen.getByLabelText('Move to section'));
    await userEvent.click(await screen.findByRole('option', { name: 'Class 1 B' }));
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Balancing sections');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/Preview OK/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('move-row-DEMO-001')).getByText(/Class 1 A → Class 1 B/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move 1' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    const [preview, commit] = calls('move_placements');
    expect(preview!.args).toMatchObject({ p_preview: true, p_reason: 'Balancing sections' });
    expect(commit!.args).toMatchObject({ p_preview: false });
    expect(commit!.args!.p_operation_id).toBe(preview!.args!.p_operation_id);
    expect(commit!.args!.p_moves).toEqual(preview!.args!.p_moves);
  });

  it('changing an input after preview discards the preview (must re-preview)', async () => {
    setContext(['students.manage']);
    onRpc(() => ({ data: { preview: true, can_apply: true, rows: [] } }));
    renderPage(
      <MovePlacementsDialog
        students={[]}
        snapshot={setupSnapshotSchema.parse(snapshotWithSections())}
        open
        onOpenChange={() => undefined}
        onDone={() => undefined}
      />,
    );
    await userEvent.click(screen.getByLabelText('Move to section'));
    await userEvent.click(await screen.findByRole('option', { name: 'Class 1 B' }));
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Move 0' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'y');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ CONFLICT reload path
describe('CONFLICT on an edit form reloads the record', () => {
  it('school profile: version mismatch → reload, user told, form shows the other change', async () => {
    setContext(['setup.manage']);
    const profile = (version: number, name: string) => ({
      school_id: ids.school,
      name,
      code: 'demo',
      udise_code: null,
      board: null,
      affiliation_no: null,
      phone: null,
      email: null,
      address_line: null,
      city: null,
      district: null,
      state: 'Telangana',
      pincode: null,
      logo_url: null,
      timezone: 'Asia/Kolkata',
      status: 'active',
      version,
      can_edit: true,
    });
    let reads = 0;
    onRpc((fn) => {
      if (fn === 'get_school_profile') {
        reads += 1;
        return {
          data: reads === 1 ? profile(1, 'Demo School') : profile(2, 'Demo School (renamed elsewhere)'),
        };
      }
      if (fn === 'save_school_profile') {
        return {
          error: { code: 'P0001', hint: 'CONFLICT', message: 'School profile changed since you opened it' },
        };
      }
      return { data: null };
    });
    renderPage(
      <>
        <SchoolProfilePage />
        <Toaster />
      </>,
    );
    const city = await screen.findByLabelText('City');
    await userEvent.type(city, 'Hyderabad');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(calls('save_school_profile')).toHaveLength(1));
    expect(calls('save_school_profile')[0]!.args).toMatchObject({
      p_expected_version: 1,
      p: { city: 'Hyderabad' },
    });
    // reloaded with the other person's change; the user is told to redo theirs
    expect(await screen.findByDisplayValue('Demo School (renamed elsewhere)')).toBeInTheDocument();
    expect(calls('get_school_profile').length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText(/Someone else changed this record/)).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toHaveValue('');
  });
});
