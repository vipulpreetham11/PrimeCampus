import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { applyServerFieldError, serverErrorField } from '@/lib/save-feedback';
import { fakeSupabase, onRpc, resetFake, rpcCalls, setupSnapshotRow } from './fake-supabase';
import { renderPage, setContext } from './render';

// M2X (close-out of M0–M2): adoption of migration 2310 and the 375px roster fix.

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { ClassesPage } = await import('@/features/setup/ClassesPage');
const { StaffGroupsPage } = await import('@/features/staff/StaffGroupsPage');
const { HomeworkRosterPage } = await import('@/features/homework/HomeworkRosterPage');
const { TeacherTodayPage } = await import('@/features/teacher/TeacherTodayPage');
const m2 = await import('./m2-fixtures');

const GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GROUP2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);

beforeEach(() => resetFake());

/** Pages that guard unsaved changes (useBlocker) need a data router. */
function renderInDataRouter(ui: ReactElement, path: string, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: route, element: ui }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** A hinted server error as PostgREST returns it: `details` is the JSON `private.fail` stored. */
function hinted(hint: string, message: string, details: Record<string, unknown>) {
  return { error: { code: 'P0001', hint, message, details: JSON.stringify(details) } };
}

// ------------------------------------------------------------------ §1 readable errors
describe('server field errors (migration 2310 details.field)', () => {
  function fakeForm(values: Record<string, unknown>) {
    const setError = vi.fn();
    return { form: { setError, getValues: () => values }, setError };
  }

  it('reads details.field only from VALIDATION_ERROR / DUPLICATE', () => {
    const dup = new AppError('DUPLICATE', 'A class with this name already exists', 'r', { field: 'name' });
    expect(serverErrorField(dup)).toBe('name');
    expect(serverErrorField(new AppError('CONFLICT', 'x', 'r', { field: 'name' }))).toBeNull();
    expect(serverErrorField(new AppError('VALIDATION_ERROR', 'x', 'r', null))).toBeNull();
    expect(serverErrorField(new Error('x'))).toBeNull();
  });

  it('maps a database column to the form field through the alias map', () => {
    const { form, setError } = fakeForm({ name: '', phone: '' });
    const err = new AppError('VALIDATION_ERROR', 'Mobile number must be 10 digits', 'r', { field: 'phone' });
    expect(applyServerFieldError(err, form)).toBe(true);
    expect(setError).toHaveBeenCalledWith(
      'phone',
      { type: 'server', message: 'Mobile number must be 10 digits' },
      { shouldFocus: true },
    );
    const aliased = new AppError('DUPLICATE', 'Taken', 'r', { field: 'full_name' });
    expect(applyServerFieldError(aliased, form, { full_name: 'name' })).toBe(true);
    expect(setError).toHaveBeenLastCalledWith('name', expect.anything(), expect.anything());
  });

  it('a field the form does not have is left for the form-level error area', () => {
    const { form, setError } = fakeForm({ name: '' });
    const err = new AppError('VALIDATION_ERROR', 'Code: 1–20 letters', 'r', { field: 'udise_code' });
    expect(applyServerFieldError(err, form)).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('New class: DUPLICATE on the name is shown under the Name field, not as a form error', async () => {
    setContext(['setup.manage']);
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      if (fn === 'save_class')
        return hinted('DUPLICATE', 'A class with this name already exists', {
          field: 'name',
          constraint: 'classes_name_uq',
        });
      return { data: null };
    });
    renderPage(<ClassesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New class' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Class name'), 'Class 1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls('save_class')).toHaveLength(1));
    const name = within(dialog).getByLabelText('Class name');
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    const describedBy = (name.getAttribute('aria-describedby') ?? '').split(' ');
    const message = within(dialog).getByText('A class with this name already exists');
    expect(describedBy).toContain(message.id);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(name).toHaveValue('Class 1'); // the user's input is kept
  });

  it('New class: an error naming no field of the form goes to the form error area', async () => {
    setContext(['setup.manage']);
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      if (fn === 'save_class')
        return hinted('VALIDATION_ERROR', 'A value has the wrong format', { field: 'something_else' });
      return { data: null };
    });
    renderPage(<ClassesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New class' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Class name'), 'Class 9');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A value has the wrong format');
    expect(within(dialog).getByLabelText('Class name')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

// ------------------------------------------------------------------ §1 staff group default salary
describe('staff group: clear default salary (save_staff_group p_clear_default_salary)', () => {
  const group = (id: string, name: string, salary: number | null, version = 4) => ({
    id,
    name,
    status: 'active',
    version,
    staff_count: 2,
    default_monthly_salary_paise: salary,
  });

  it('"No default salary" and ₹0 are shown differently', async () => {
    setContext(['setup.manage', 'staff_finance.read', 'staff_finance.manage']);
    onRpc((fn) => ({
      data:
        fn === 'list_staff_groups'
          ? [group(GROUP, 'Teaching staff', null), group(GROUP2, 'Volunteers', 0)]
          : null,
    }));
    renderPage(<StaffGroupsPage />);
    const none = within(await screen.findByTestId('group-row-Teaching staff')).getByTestId('group-salary');
    const zero = within(screen.getByTestId('group-row-Volunteers')).getByTestId('group-salary');
    expect(none).toHaveTextContent('No default salary');
    expect(none).not.toHaveTextContent('₹');
    expect(zero).toHaveTextContent('₹0.00');
  });

  it('Clear default salary sends p_clear_default_salary with the version and no amount; Undo cancels it', async () => {
    setContext(['setup.manage', 'staff_finance.read', 'staff_finance.manage']);
    onRpc((fn) => {
      if (fn === 'list_staff_groups') return { data: [group(GROUP, 'Teaching staff', 3000000)] };
      if (fn === 'save_staff_group')
        return { data: { staff_group_id: GROUP, version: 5, default_salary_paise: null } };
      return { data: null };
    });
    renderPage(<StaffGroupsPage />);
    await userEvent.click(
      within(await screen.findByTestId('group-row-Teaching staff')).getByRole('button', { name: 'Edit' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear default salary' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('will be removed when you save');
    expect(within(dialog).queryByLabelText('Default monthly salary')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(within(dialog).getByLabelText('Default monthly salary')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear default salary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls('save_staff_group')).toHaveLength(1));
    const args = calls('save_staff_group')[0]!.args!;
    expect(args).toMatchObject({ p_id: GROUP, p_expected_version: 4, p_clear_default_salary: true });
    expect(args).not.toHaveProperty('p_default_salary_paise');
  });

  it('without staff_finance.manage there is no Clear action', async () => {
    setContext(['setup.manage', 'staff_finance.read']);
    onRpc((fn) => ({ data: fn === 'list_staff_groups' ? [group(GROUP, 'Teaching staff', 3000000)] : null }));
    renderPage(<StaffGroupsPage />);
    await userEvent.click(
      within(await screen.findByTestId('group-row-Teaching staff')).getByRole('button', { name: 'Edit' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Clear default salary' })).not.toBeInTheDocument();
  });

  it('a group without a default says so in the dialog', async () => {
    setContext(['setup.manage', 'staff_finance.read', 'staff_finance.manage']);
    onRpc((fn) => ({ data: fn === 'list_staff_groups' ? [group(GROUP, 'Teaching staff', null)] : null }));
    renderPage(<StaffGroupsPage />);
    await userEvent.click(
      within(await screen.findByTestId('group-row-Teaching staff')).getByRole('button', { name: 'Edit' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^No default salary\./)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Clear default salary' })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ §1 homework roster + Teacher Today
describe('homework roster uses the server can_check; Teacher Today shows subject, section and counts', () => {
  it('a teacher whose roster says can_check: false sees it read-only (no guessing from capabilities)', async () => {
    setContext(['lessons.teach', 'staff.member'], 'teacher');
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: m2.snapshotM2() };
      if (fn === 'get_homework_roster') return { data: m2.homeworkRosterRow({ can_check: false }) };
      return { data: null };
    });
    renderInDataRouter(<HomeworkRosterPage />, `/homework/${m2.M2.homework}`, '/homework/:assignmentId');
    await screen.findByTestId('homework-roster');
    expect(screen.getByText('You can see the checks but not change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save checks/ })).not.toBeInTheDocument();
  });

  it('can_check: true shows the editor', async () => {
    setContext(['academic.read_all'], 'principal');
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return { data: m2.snapshotM2() };
      if (fn === 'get_homework_roster') return { data: m2.homeworkRosterRow({ can_check: true }) };
      return { data: null };
    });
    renderInDataRouter(<HomeworkRosterPage />, `/homework/${m2.M2.homework}`, '/homework/:assignmentId');
    await screen.findByTestId('homework-roster');
    expect(screen.queryByText('You can see the checks but not change them.')).not.toBeInTheDocument();
  });

  it('Teacher Today: "Mathematics · Class 1 A — 12 of 28 checked, due 21 Oct"', async () => {
    setContext(['lessons.teach', 'staff.member'], 'teacher');
    onRpc((fn) => {
      if (fn === 'get_teacher_today')
        return {
          data: {
            date: '2026-10-21',
            mode: 'daily',
            lessons: [],
            class_teacher_sections: [],
            homework_to_check: [
              {
                assignment_id: m2.M2.homework,
                section_id: m2.M2.sectionA,
                section: 'Class 1 A',
                subject_id: m2.M2.maths,
                subject: 'Mathematics',
                assigned_on: '2026-10-19',
                due_on: '2026-10-21',
                version: 1,
                eligible: 28,
                checked: 12,
              },
            ],
          },
        };
      return { data: null };
    });
    renderPage(<TeacherTodayPage />, { path: '/today?date=2026-10-21', route: '/today' });
    const item = await screen.findByTestId('homework-to-check');
    expect(item).toHaveTextContent('Mathematics · Class 1 A — 12 of 28 checked, due 21 Oct');
    expect(within(item.parentElement!).getByRole('link', { name: 'Check' })).toHaveAttribute(
      'href',
      `/homework/${m2.M2.homework}`,
    );
  });
});
