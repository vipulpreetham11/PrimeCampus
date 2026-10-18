import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { AppError } from '@/lib/errors';
import { OperationTracker } from '@/lib/operation';
import { fakeSupabase, ids, onRpc, resetFake, rpcCalls, setupSnapshotRow } from './fake-supabase';
import { renderPage, setContext } from './render';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { SubjectsPage } = await import('@/features/setup/SubjectsPage');
const { StaffGroupsPage } = await import('@/features/staff/StaffGroupsPage');
const { UsersPage } = await import('@/features/users/UsersPage');
const { useStaffGroups } = await import('@/features/staff/hooks');
const { ClassesPage } = await import('@/features/setup/ClassesPage');
const { PatternDialog } = await import('@/features/setup/CalendarPage');
const { TeachingBySectionPage } = await import('@/features/staff/TeachingBySectionPage');
const { calendarSchema, setupSnapshotSchema } = await import('@/contracts/setup');
const { MovePlacementsDialog } = await import('@/features/students/MovePlacementsDialog');

/** A general screen that reads staff groups through the shared key (e.g. the staff directory filter). */
function SharedGroupsReader() {
  const q = useStaffGroups();
  return q.data ? <p>shared groups loaded</p> : null;
}

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const SUBJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

beforeEach(() => resetFake());

// ------------------------------------------------------------------ item 1: no CONFLICT retry loop
describe('list edit dialogs follow the latest version after CONFLICT', () => {
  it('subjects: CONFLICT → reload → the reopened form saves with the NEW version', async () => {
    setContext(['setup.manage']);
    let version = 1;
    onRpc((fn, args) => {
      if (fn === 'get_setup_snapshot') {
        const name = version === 1 ? 'Maths' : 'Mathematics (renamed elsewhere)';
        return {
          data: {
            ...setupSnapshotRow(),
            subjects: [{ id: SUBJECT, name, code: 'MATH', status: 'active', version }],
          },
        };
      }
      if (fn === 'save_subject') {
        if (args?.p_expected_version !== version) {
          version = 2; // someone else saved meanwhile
          return {
            error: { code: 'P0001', hint: 'CONFLICT', message: 'Subject changed since you opened it' },
          };
        }
        return { data: { subject_id: SUBJECT, version: version + 1 } };
      }
      return { data: null };
    });
    renderPage(
      <>
        <SubjectsPage />
        <Toaster />
      </>,
    );
    await userEvent.click(
      within(await screen.findByTestId('subject-row-MATH')).getByRole('button', { name: 'Edit' }),
    );
    // Another session saves before ours: the server is now at version 2.
    version = 2;
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Maths I');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Someone else changed this record/)).toBeInTheDocument();
    expect(calls('save_subject')[0]!.args).toMatchObject({ p_expected_version: 1 });
    // The dialog now shows the reloaded record (re-keyed on version 2) …
    expect(await screen.findByDisplayValue('Mathematics (renamed elsewhere)')).toBeInTheDocument();
    // … and redoing the change saves against version 2 instead of failing forever.
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Maths I');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('save_subject')).toHaveLength(2));
    expect(calls('save_subject')[1]!.args).toMatchObject({ p_expected_version: 2, p_name: 'Maths I' });
  });
});

// ------------------------------------------------------------------ item 3: operation id rules
describe('OperationTracker — when an operation id is kept or renewed', () => {
  const err = (code: string) => new AppError(code as never, 'x', 'r');

  it.each(['UNKNOWN', 'NETWORK', 'TEMPORARILY_UNAVAILABLE'])(
    'keeps the id after %s for an identical retry',
    (code) => {
      const t = new OperationTracker();
      const first = t.idFor({ a: 1 });
      t.failed(err(code));
      expect(t.idFor({ a: 1 })).toBe(first);
    },
  );

  it.each(['VALIDATION_ERROR', 'FORBIDDEN', 'DUPLICATE', 'NOT_FOUND', 'CONFLICT', 'LIMIT_REACHED'])(
    'renews the id after the definite refusal %s',
    (code) => {
      const t = new OperationTracker();
      const first = t.idFor({ a: 1 });
      t.failed(err(code));
      expect(t.idFor({ a: 1 })).not.toBe(first);
    },
  );

  it('an edited payload after a kept id starts a new id; success renews it', () => {
    const t = new OperationTracker();
    const first = t.idFor({ a: 1 });
    t.failed(err('NETWORK'));
    const edited = t.idFor({ a: 2 });
    expect(edited).not.toBe(first);
    expect(t.idFor({ a: 2 })).toBe(edited);
    t.succeeded();
    expect(t.idFor({ a: 2 })).not.toBe(edited);
  });
});

// ------------------------------------------------------------------ item 2: provision id survives closing
describe('Create login keeps its operation id and typed values across close/reopen', () => {
  const provisionBodies = () =>
    fakeSupabase.functions.invoke.mock.calls.map(
      (c) => (c[1] as { body: { action: string; operation_id: string; username: string } }).body,
    );

  async function fillAndSubmit(username?: string) {
    if (username !== undefined) {
      await userEvent.type(screen.getByLabelText('Username'), username);
      await userEvent.type(screen.getByLabelText('Full name'), 'Ravi Kumar');
      await userEvent.click(screen.getByRole('checkbox', { name: /Accountant/ }));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Create login' }));
  }

  beforeEach(() => {
    setContext(['users.manage', 'staff.read']);
    onRpc((fn) => ({ data: fn === 'list_school_users' || fn === 'list_staff' ? [] : null }));
  });

  it('network failure → close → reopen → retry resends the same id and username', async () => {
    fakeSupabase.functions.invoke
      .mockResolvedValueOnce({
        data: null,
        error: Object.assign(new Error('Failed to send a request'), { name: 'FunctionsFetchError' }),
      })
      .mockResolvedValueOnce({
        data: {
          account_id: ids.account,
          username: 'demo.acct',
          temporary_password: 'Abcdefgh123456',
          must_change_password: true,
        },
        error: null,
      });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create login' }));
    await fillAndSubmit('demo.acct');
    expect(await screen.findByText(/offline or the server could not be reached/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Username')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Create login' }));
    expect(screen.getByLabelText('Username')).toHaveValue('demo.acct'); // typed values survived
    await fillAndSubmit();

    expect(await screen.findByTestId('one-time-secret')).toHaveTextContent('Abcdefgh123456');
    const [first, retry] = provisionBodies();
    expect(retry!.operation_id).toBe(first!.operation_id);
    expect(retry!.username).toBe('demo.acct');
  });

  it('a definite refusal (DUPLICATE) starts a new id for the next attempt', async () => {
    fakeSupabase.functions.invoke.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(
        new Response(JSON.stringify({ ok: false, code: 'DUPLICATE', message: 'That username is taken.' }), {
          status: 409,
        }),
      ),
    });
    renderPage(<UsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create login' }));
    await fillAndSubmit('demo.acct');
    expect(await screen.findByText('That username is taken.')).toBeInTheDocument();
    await fillAndSubmit();
    await waitFor(() => expect(provisionBodies()).toHaveLength(2));
    const [first, second] = provisionBodies();
    expect(second!.operation_id).not.toBe(first!.operation_id);
  });
});

// ------------------------------------------------------------------ items 5 + 9: staff group salary
describe('staff group default salary', () => {
  const group = (salary: number | null) => ({
    id: GROUP,
    name: 'Teaching staff',
    status: 'active',
    version: 1,
    staff_count: 2,
    default_monthly_salary_paise: salary,
  });

  it('an existing default cannot be emptied (the server cannot clear it)', async () => {
    setContext(['setup.manage', 'staff_finance.read', 'staff_finance.manage']);
    onRpc((fn) => ({ data: fn === 'list_staff_groups' ? [group(3000000)] : null }));
    renderPage(<StaffGroupsPage />);
    await userEvent.click(
      within(await screen.findByTestId('group-row-Teaching staff')).getByRole('button', { name: 'Edit' }),
    );
    await userEvent.clear(screen.getByLabelText('Default monthly salary'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('To change it, enter a new amount.')).toBeInTheDocument();
    expect(calls('save_staff_group')).toHaveLength(0);
  });

  it('the shared staff-groups cache never holds the salary; finance screens use their own key', async () => {
    setContext(['setup.manage', 'staff_finance.read', 'staff_finance.manage']);
    onRpc((fn) => ({ data: fn === 'list_staff_groups' ? [group(3000000)] : null }));
    const { qc } = renderPage(
      <>
        <StaffGroupsPage />
        <SharedGroupsReader />
      </>,
    );
    expect(await screen.findByTestId('group-salary')).toHaveTextContent('30,000');
    expect(await screen.findByText('shared groups loaded')).toBeInTheDocument();
    const cached = qc
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, data: q.state.data }));
    expect(cached.some((c) => c.key.includes('staff-groups-finance'))).toBe(true);
    const shared = cached.filter((c) => c.key.includes('staff-groups') && c.data !== undefined);
    expect(shared.length).toBeGreaterThan(0);
    for (const c of shared)
      for (const g of c.data as { default_monthly_salary_paise: number | null }[])
        expect(g.default_monthly_salary_paise).toBeNull();
  });
});

// ------------------------------------------------------------------ shared fixtures for items 6–8
const CLASS_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECTION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LATIN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
function snapshot() {
  return {
    ...setupSnapshotRow(),
    academic_years: [
      {
        id: ids.year,
        name: '2026-27',
        start_date: '2026-04-01',
        end_date: '2027-03-31',
        is_current: true,
        status: 'active',
        version: 1,
      },
    ],
    selected_year_id: ids.year,
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
    ],
    subjects: [
      { id: SUBJECT, name: 'Maths', code: 'MATH', status: 'active', version: 1 },
      { id: LATIN, name: 'Latin', code: 'LAT', status: 'retired', version: 2 },
    ],
  };
}

describe('class subjects keep mappings to retired subjects (item 7)', () => {
  it('shows the retired subject read-only and includes it unchanged in the full-replace save', async () => {
    setContext(['setup.manage']);
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: snapshot() };
      if (fn === 'list_class_subjects')
        return {
          data: [
            {
              id: ids.membership,
              class_id: CLASS_1,
              subject_id: SUBJECT,
              subject: 'Maths',
              code: 'MATH',
              is_optional: false,
              sort_order: 1,
              status: 'active',
            },
            {
              id: ids.membership2,
              class_id: CLASS_1,
              subject_id: LATIN,
              subject: 'Latin',
              code: 'LAT',
              is_optional: true,
              sort_order: 9,
              status: 'active',
            },
          ],
        };
      if (fn === 'save_class_subjects') return { data: { count: 2 } };
      return { data: null };
    });
    renderPage(<ClassesPage />);
    await userEvent.click(
      within(await screen.findByTestId('class-card-Class 1')).getByRole('button', { name: 'Subjects' }),
    );
    const retired = await screen.findByRole('list', { name: 'Retired subjects (kept)' });
    expect(within(retired).getByText('Latin')).toBeInTheDocument();
    expect(within(retired).getByText('Retired')).toBeInTheDocument();
    expect(within(retired).queryByRole('checkbox')).not.toBeInTheDocument(); // read-only
    await userEvent.click(screen.getByRole('button', { name: 'Save subjects' }));
    await waitFor(() => expect(calls('save_class_subjects')).toHaveLength(1));
    expect(calls('save_class_subjects')[0]!.args!.p_subjects).toEqual([
      { subject_id: SUBJECT, is_optional: false, sort_order: 1 },
      { subject_id: LATIN, is_optional: true, sort_order: 9 },
    ]);
  });
});

describe('staff-group weekly pattern saves only the changed weekdays (item 6)', () => {
  it('a group change to Saturday sends just Saturday, not the copied school default', async () => {
    setContext(['setup.manage', 'staff.member']);
    onRpc((fn) => ({ data: fn === 'save_calendar_pattern' ? { count: 1 } : null }));
    const schoolDefault = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      id: `00000000-0000-4000-8000-00000000000${weekday}`,
      weekday,
      day_type: weekday === 7 ? 'weekly_off' : 'working',
      period_schedule_id: null,
      staff_group_id: null,
      version: 1,
    }));
    const calendar = calendarSchema.parse({
      academic_year: { id: ids.year, name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' },
      audience: 'staff',
      staff_group_id: GROUP,
      patterns: schoolDefault,
      overrides: [],
      resolved: [],
      totals: { working_days: 0, half_days: 0, holidays: 0, weekly_offs: 0, working_weight: 0 },
    });
    renderPage(
      <PatternDialog
        calendar={calendar}
        snapshot={setupSnapshotSchema.parse(snapshot())}
        yearId={ids.year}
        audience="staff"
        staffGroupId={GROUP}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getAllByText('School default')).toHaveLength(7);
    await userEvent.click(screen.getByRole('combobox', { name: 'Saturday day type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Weekly off' }));
    expect(screen.getByText('Changed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save pattern' }));
    await waitFor(() => expect(calls('save_calendar_pattern')).toHaveLength(1));
    expect(calls('save_calendar_pattern')[0]!.args).toMatchObject({
      p_staff_group_id: GROUP,
      p_patterns: [{ weekday: 6, day_type: 'weekly_off', period_schedule_id: null }],
    });
  });
});

describe('teaching assignments include upcoming ones (item 8)', () => {
  it('section page lists an assignment starting later with “Starts <date>”', async () => {
    setContext(['staff.member', 'staff.read', 'timetable.manage']);
    const assignment = (id: string, staff: string, kind: string, from: string, to: string | null) => ({
      id,
      academic_year_id: ids.year,
      section_id: SECTION_A,
      section: 'Class 1 A',
      staff_id: ids.account,
      staff,
      kind,
      subject_id: kind === 'subject' ? SUBJECT : null,
      subject: kind === 'subject' ? 'Maths' : null,
      effective_from: from,
      effective_to: to,
    });
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: snapshot() };
      if (fn === 'list_staff') return { data: [] };
      if (fn === 'list_teaching_assignments')
        return {
          data: [
            assignment(ids.membership, 'Ravi Kumar', 'class_teacher', '2026-04-01', null),
            assignment(ids.membership2, 'Meera Rao', 'subject', '2099-01-05', null),
            assignment(ids.child1, 'Old Teacher', 'subject', '2026-04-01', '2026-05-01'),
          ],
        };
      return { data: null };
    });
    renderPage(<TeachingBySectionPage />);
    await userEvent.click(await screen.findByLabelText('Section (current year)'));
    await userEvent.click(await screen.findByRole('option', { name: 'Class 1 A' }));
    expect(await screen.findByText('Meera Rao · Maths')).toBeInTheDocument();
    expect(screen.getByText('Starts 5 Jan 2099')).toBeInTheDocument();
    expect(screen.getByTestId('class-teacher')).toHaveTextContent('Ravi Kumar');
    expect(screen.queryByText(/Old Teacher/)).not.toBeInTheDocument(); // ended: hidden
    // The request no longer filters on "active today" (that would drop upcoming rows).
    expect(calls('list_teaching_assignments').at(-1)!.args).not.toHaveProperty('p_active_on');
  });
});

describe('placement move: DUPLICATE "operation id already used for different content" (item 3)', () => {
  it('renews the id and requires a new preview', async () => {
    setContext(['students.manage', 'students.read_all']);
    const SECTION_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const snap = snapshot();
    snap.sections.push({ ...snap.sections[0]!, id: SECTION_B, name: 'B', sort_order: 1 });
    let commits = 0;
    onRpc((fn, args) => {
      if (fn !== 'move_placements') return { data: null };
      if (args?.p_preview) return { data: { preview: true, can_apply: true, rows: [] } };
      commits += 1;
      return commits === 1
        ? {
            error: {
              code: 'P0001',
              hint: 'DUPLICATE',
              message: 'This operation id was already used for different content',
            },
          }
        : { data: { preview: false, batch_id: ids.membership, moved: 0, rows: [] } };
    });
    renderPage(
      <MovePlacementsDialog
        students={[]}
        snapshot={setupSnapshotSchema.parse(snap)}
        open
        onOpenChange={() => undefined}
        onDone={() => undefined}
      />,
    );
    await userEvent.click(screen.getByLabelText('Move to section'));
    await userEvent.click(await screen.findByRole('option', { name: 'Class 1 B' }));
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Balancing');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move 0' }));
    // refused: the preview is gone, so the user must preview again
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move 0' }));
    await waitFor(() => expect(calls('move_placements')).toHaveLength(4));
    const [p1, c1, p2, c2] = calls('move_placements').map((c) => c.args!.p_operation_id);
    expect(c1).toBe(p1);
    expect(p2).not.toBe(c1); // new id after the definite refusal
    expect(c2).toBe(p2);
  });
});
