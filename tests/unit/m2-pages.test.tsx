import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { contextSchema } from '@/contracts/session';
import { sessionStore } from '@/lib/session/store';
import { contextRow, fakeSupabase, ids, onRpc, resetFake, rpcCalls } from './fake-supabase';
import {
  CAPS,
  classSubjectsM2,
  diaryEntryRow,
  homeworkRosterRow,
  M2,
  marksSavedRow,
  periodRosterRow,
  snapshotM2,
  staffListM2,
  timetableVersionRow,
} from './m2-fixtures';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { TimetableEditorPage } = await import('@/features/timetable/TimetableEditorPage');
const { LessonRefreshResult } = await import('@/features/timetable/LessonsGenerate');
const { MarkingRosterPage } = await import('@/features/attendance/MarkingRosterPage');
const { HomeworkRosterPage } = await import('@/features/homework/HomeworkRosterPage');
const { LessonPage } = await import('@/features/diary/LessonPage');
const { ChildHomePage } = await import('@/features/child/ChildPages');

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const NETWORK_ERROR = { error: { message: 'TypeError: Failed to fetch' } };
const hinted = (hint: string, message: string, details = '') => ({
  error: { code: 'P0001', hint, message, details },
});

function setCtx(caps: string[], role: string, extra: Record<string, unknown> = {}) {
  sessionStore.reset();
  sessionStore.set({
    status: 'ready',
    account: { accountId: ids.account, username: 'demo.x', displayName: 'Demo', isOperator: false },
    context: contextSchema.parse({ ...contextRow(1, role, caps), ...extra }),
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

/** Default replies for the reads every M2 page makes. */
function baseReads(fn: string) {
  if (fn === 'get_setup_snapshot') return { data: snapshotM2() };
  if (fn === 'list_class_subjects') return { data: classSubjectsM2() };
  if (fn === 'list_staff') return { data: staffListM2() };
  return null;
}

beforeEach(() => {
  resetFake();
  setCtx(CAPS.admin, 'admin');
});

// ------------------------------------------------------------------ timetable grid
describe('timetable grid editor', () => {
  const open = (version = timetableVersionRow()) => {
    let current = version;
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_timetable_version') return { data: current };
      return { data: null };
    });
    const r = renderAt(`/timetable/${M2.version}`, [
      { path: '/timetable/:versionId', element: <TimetableEditorPage /> },
    ]);
    return { ...r, setVersion: (v: ReturnType<typeof timetableVersionRow>) => (current = v) };
  };

  it('shows breaks (not editable), "Unassigned" for a lesson without a teacher and the clash in its cell', async () => {
    open();
    const grid = await screen.findByTestId('timetable-grid');
    expect(within(grid).getAllByText('Break — no lessons')).toHaveLength(1);
    const mon2 = within(grid).getByRole('button', { name: /Monday, Period 2: English, unassigned/ });
    expect(within(mon2).getByText('Unassigned')).toBeInTheDocument();
    const mon1 = within(grid).getByRole('button', {
      name: /Monday, Period 1: Mathematics, Meera Rao, teacher clash/,
    });
    await waitFor(() =>
      expect(within(mon1).getByTestId('cell-clash')).toHaveTextContent(
        'Clash: Meera Rao also teaches Class 1 B then',
      ),
    );
    expect(screen.getByTestId('unassigned-count')).toHaveTextContent('1');
    expect(screen.getByTestId('conflict-count')).toHaveTextContent('1');
    // activation is blocked while the clash exists
    expect(screen.getByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(screen.getByText(/Activation is blocked: 1 teacher clash/)).toBeInTheDocument();
  });

  it('editing a cell and saving sends the whole grid with the draft version; the warnings come back', async () => {
    const user = userEvent.setup();
    open();
    const grid = await screen.findByTestId('timetable-grid');
    await waitFor(() => expect(calls('list_staff')).toHaveLength(1));
    // Tuesday Period 3 is empty → set Science with Ravi Kumar
    await user.click(within(grid).getByRole('button', { name: /Tuesday, Period 3: no lesson/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Subject'));
    await user.click(await screen.findByRole('option', { name: 'Science' }));
    await user.click(within(dialog).getByLabelText('Teacher'));
    await user.click(await screen.findByRole('option', { name: 'Ravi Kumar' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    // clashes are re-checked by the server on save
    expect(screen.queryByTestId('cell-clash')).not.toBeInTheDocument();

    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'save_timetable_draft')
        return {
          data: {
            timetable_version_id: M2.version,
            version: 4,
            conflicts: [],
            unassigned_periods: 15,
            subjects_not_in_class: [],
          },
        };
      if (fn === 'get_timetable_version') return { data: timetableVersionRow({ version: 4 }) };
      return { data: null };
    });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls('save_timetable_draft')).toHaveLength(1));
    expect(calls('save_timetable_draft')[0]!.args).toEqual({
      p_ctx_rev: 1,
      p_section_id: M2.sectionA,
      p_period_schedule_id: M2.schedule,
      p_effective_from: '2026-10-12',
      p_entries: [
        { weekday: 1, slot_ordinal: 1, subject_id: M2.maths, staff_id: M2.meera },
        { weekday: 1, slot_ordinal: 2, subject_id: M2.english, staff_id: null },
        { weekday: 2, slot_ordinal: 4, subject_id: M2.science, staff_id: M2.ravi },
      ],
      p_version_id: M2.version,
      p_expected_version: 3,
    });
  });

  it('CONFLICT on save reloads the draft (the user redoes the change)', async () => {
    const user = userEvent.setup();
    open();
    const grid = await screen.findByTestId('timetable-grid');
    await user.click(within(grid).getByRole('button', { name: /Monday, Period 2: English/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'No lesson in this period' }),
    );
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'save_timetable_draft')
        return hinted('CONFLICT', 'Someone else changed this draft. Reload to see it.');
      if (fn === 'get_timetable_version') return { data: timetableVersionRow({ version: 5 }) };
      return { data: null };
    });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText(/Someone else changed this draft\. It has been reloaded/),
    ).toBeInTheDocument();
    await waitFor(() => expect(calls('get_timetable_version').length).toBeGreaterThanOrEqual(2));
    // reloaded grid shows the server's cells again (English back in Monday P2)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Monday, Period 2: English, unassigned/ }),
      ).toBeInTheDocument(),
    );
  });

  it('an active timetable is read-only', async () => {
    open(timetableVersionRow({ status: 'active', can_edit: false, conflicts: [] }));
    const grid = await screen.findByTestId('timetable-grid');
    expect(within(grid).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ lesson refresh
describe('lesson refresh result', () => {
  it('shows created / updated / cancelled and lists lessons kept because they are in use', async () => {
    onRpc((fn) => baseReads(fn) ?? { data: null });
    renderAt('/', [
      {
        path: '/',
        element: (
          <LessonRefreshResult
            result={{
              created: 12,
              updated: 3,
              cancelled_unused: 2,
              cancelled_timetable_changed: 2,
              cancelled_not_working: 0,
              kept_used: [
                { lesson_session_id: 77, date: '2026-10-21', section_id: M2.sectionA, slot_ordinal: 2 },
              ],
            }}
          />
        ),
      },
    ]);
    expect(screen.getByTestId('result-created')).toHaveTextContent('12');
    expect(screen.getByTestId('result-updated')).toHaveTextContent('3');
    expect(screen.getByTestId('result-cancelled')).toHaveTextContent('2');
    expect(screen.getByTestId('result-kept')).toHaveTextContent('1');
    expect(screen.getByText(/already have attendance, diary or homework — not changed/)).toBeInTheDocument();
    const kept = screen.getByTestId('kept-lessons');
    await waitFor(() => expect(kept).toHaveTextContent('Wed 21 Oct · Class 1 A · Slot 2'));
    expect(within(kept).getByRole('link', { name: 'Open day' })).toHaveAttribute(
      'href',
      `/schedule?date=2026-10-21&section=${M2.sectionA}`,
    );
  });
});

// ------------------------------------------------------------------ marking roster
describe('marking roster', () => {
  const RECENT = new Date('2026-10-16T12:00:00+05:30');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RECENT);
    setCtx(CAPS.teacher, 'teacher', { staff_id: M2.meera });
  });
  afterEach(() => vi.useRealTimers());

  const reads =
    (roster = periodRosterRow()) =>
    (fn: string) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_marking_roster') return { data: roster };
      if (fn === 'get_diary_entry') return { data: diaryEntryRow(null) };
      return null;
    };
  const openRoster = (handler: (fn: string, args?: Record<string, unknown>) => unknown) => {
    onRpc((fn, args) => (handler(fn, args) ?? { data: null }) as never);
    return renderAt('/attendance/lesson/501', [
      { path: '/attendance/lesson/:lessonId', element: <MarkingRosterPage /> },
    ]);
  };
  const row = (name: string) => screen.getAllByTestId('roster-row').find((r) => r.dataset.student === name)!;

  it('unmarked is its own state; "mark all present" then exceptions; only changed rows are sent', async () => {
    const user = userEvent.setup();
    const read = reads();
    openRoster((fn) => read(fn) ?? (fn === 'mark_student_attendance' ? { data: marksSavedRow() } : null));
    await screen.findByTestId('marking-roster');
    expect(row('Aarav Sharma')).toHaveAttribute('data-state', 'unmarked');
    expect(within(row('Aarav Sharma')).getByText('Unmarked')).toBeInTheDocument();
    // neither Present nor Absent is selected for an unmarked student
    expect(within(row('Aarav Sharma')).queryAllByRole('radio', { checked: true })).toHaveLength(0);

    // Chetan is already marked: the button fills only the 2 unmarked rows
    await user.click(screen.getByRole('button', { name: 'Mark remaining 2 present' }));
    expect(row('Aarav Sharma')).toHaveAttribute('data-state', 'changed');
    expect(row('Chetan Das')).toHaveAttribute('data-state', 'marked');
    // exception: Bela absent
    await user.click(within(row('Bela Nair')).getByRole('radio', { name: 'Absent' }));
    expect(screen.getByTestId('roster-summary')).toHaveTextContent('3 of 3 marked');

    await user.click(screen.getByRole('button', { name: /Save attendance/ }));
    await waitFor(() => expect(calls('mark_student_attendance')).toHaveLength(1));
    const args = calls('mark_student_attendance')[0]!.args!;
    expect(args).toMatchObject({ p_kind: 'period', p_lesson_session_id: 501 });
    expect(args.p_marks).toEqual([
      { student_id: M2.s1, status: 'P', expected_version: null },
      { student_id: M2.s2, status: 'A', expected_version: null },
    ]);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('keyboard: ↓ moves between rows, P / L / A mark the focused row and move on', async () => {
    const read = reads();
    openRoster((fn) => read(fn));
    await screen.findByTestId('marking-roster');
    const first = row('Aarav Sharma');
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'a' });
    expect(within(first).getByRole('radio', { name: 'Absent' })).toHaveAttribute('aria-checked', 'true');
    expect(row('Bela Nair')).toHaveFocus();
    fireEvent.keyDown(row('Bela Nair'), { key: 'l' });
    expect(within(row('Bela Nair')).getByRole('radio', { name: 'Late' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // H (half day) is not a period status: ignored
    fireEvent.keyDown(row('Chetan Das'), { key: 'h' });
    expect(row('Chetan Das')).toHaveAttribute('data-state', 'marked');
    fireEvent.keyDown(row('Chetan Das'), { key: 'ArrowUp' });
    expect(row('Bela Nair')).toHaveFocus();
  });

  it('a failed save keeps the marks ("Not saved — retry"); the retry sends the SAME operation id', async () => {
    const user = userEvent.setup();
    const read = reads();
    let fail = true;
    openRoster((fn) => {
      const r = read(fn);
      if (r) return r;
      if (fn === 'mark_student_attendance') return fail ? NETWORK_ERROR : { data: marksSavedRow() };
      return null;
    });
    await screen.findByTestId('marking-roster');
    await user.click(screen.getByRole('button', { name: 'Mark remaining 2 present' }));
    await user.click(screen.getByRole('button', { name: /Save attendance/ }));
    expect(await screen.findByTestId('not-saved')).toHaveTextContent('Not saved — retry');
    // marks are still on screen, still unsaved
    expect(row('Aarav Sharma')).toHaveAttribute('data-state', 'changed');
    expect(within(row('Aarav Sharma')).getByRole('radio', { name: 'Present' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fail = false;
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(calls('mark_student_attendance')).toHaveLength(2));
    const [a, b] = calls('mark_student_attendance');
    expect(b!.args!.p_operation_id).toBe(a!.args!.p_operation_id);
    expect(b!.args!.p_marks).toEqual(a!.args!.p_marks);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();

    // a NEW action after success gets a new id
    await user.click(within(row('Chetan Das')).getByRole('radio', { name: 'Late' }));
    await user.click(screen.getByRole('button', { name: /Save attendance/ }));
    await waitFor(() => expect(calls('mark_student_attendance')).toHaveLength(3));
    expect(calls('mark_student_attendance')[2]!.args!.p_operation_id).not.toBe(a!.args!.p_operation_id);
    expect(calls('mark_student_attendance')[2]!.args!.p_marks).toEqual([
      { student_id: M2.s3, status: 'L', expected_version: 2 },
    ]);
  });

  it('conflict: someone else changed a student first — their value is shown; "use mine" re-sends with their version', async () => {
    const user = userEvent.setup();
    let roster = periodRosterRow();
    const read = (fn: string) => reads(roster)(fn);
    let saves = 0;
    openRoster((fn) => {
      const r = read(fn);
      if (r) return r;
      if (fn === 'mark_student_attendance') {
        saves += 1;
        if (saves === 1) {
          // the other tab saved Chetan = Absent (version 3) before us
          roster = periodRosterRow({
            students: periodRosterRow().students.map((s) =>
              s.student_id === M2.s3 ? { ...s, status: 'A', version: 3 } : s,
            ),
          });
          return {
            data: marksSavedRow({
              marked: 0,
              conflicts: [{ student_id: M2.s3, current_status: 'A', current_version: 3 }],
              unmarked_remaining: 2,
            }),
          };
        }
        return { data: marksSavedRow({ marked: 0, changed: 1 }) };
      }
      return null;
    });
    await screen.findByTestId('marking-roster');
    await user.click(within(row('Chetan Das')).getByRole('radio', { name: 'Late' }));
    await user.click(screen.getByRole('button', { name: /Save attendance/ }));
    await waitFor(() => expect(row('Chetan Das')).toHaveAttribute('data-state', 'conflict'));
    const conflict = within(row('Chetan Das')).getByTestId('row-conflict');
    expect(conflict).toHaveTextContent('Someone else saved Absent before you. Your choice: Late.');
    expect(screen.getByText(/Saved, except 1 row someone else changed first/)).toBeInTheDocument();
    await user.click(within(conflict).getByRole('button', { name: 'Use mine (Late)' }));
    await user.click(screen.getByRole('button', { name: /Save attendance/ }));
    await waitFor(() => expect(calls('mark_student_attendance')).toHaveLength(2));
    expect(calls('mark_student_attendance')[1]!.args!.p_marks).toEqual([
      { student_id: M2.s3, status: 'L', expected_version: 3 },
    ]);
  });

  it('read-only when the server says can_mark is false; daily-mode dates point to the day register', async () => {
    const read = reads(periodRosterRow({ can_mark: false, mode_on_date: 'daily' }));
    openRoster((fn) => read(fn));
    expect(await screen.findByTestId('roster-blocked')).toHaveTextContent(/day-wise attendance/);
    expect(screen.getByRole('link', { name: 'Open the day register' })).toHaveAttribute(
      'href',
      `/attendance/daily/${M2.sectionA}/2026-10-16`,
    );
    expect(screen.queryByRole('button', { name: /Save attendance/ })).not.toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});

// ------------------------------------------------------------------ homework checks
describe('homework checking roster', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:00:00+05:30'));
    setCtx(CAPS.teacher, 'teacher', { staff_id: M2.meera });
  });
  afterEach(() => vi.useRealTimers());

  const open = (handler: (fn: string) => unknown) => {
    onRpc((fn) => (baseReads(fn) ?? handler(fn) ?? { data: null }) as never);
    return renderAt(`/homework/${M2.homework}`, [
      { path: '/homework/:assignmentId', element: <HomeworkRosterPage /> },
    ]);
  };
  const row = (name: string) => screen.getAllByTestId('check-row').find((r) => r.dataset.student === name)!;

  it('unchecked is its own state; completed + correction required is sent; unchecked students are not', async () => {
    const user = userEvent.setup();
    open((fn) =>
      fn === 'get_homework_roster'
        ? { data: homeworkRosterRow() }
        : fn === 'mark_homework_checks'
          ? { data: { saved: 2, conflicts: [] } }
          : null,
    );
    await screen.findByTestId('homework-roster');
    expect(row('Aarav Sharma')).toHaveAttribute('data-state', 'unmarked');
    expect(within(row('Aarav Sharma')).getByText('Unchecked')).toBeInTheDocument();
    expect(within(row('Aarav Sharma')).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(row('Chetan Das')).toHaveAttribute('data-state', 'marked');
    expect(within(row('Chetan Das')).getByRole('radio', { name: 'Completed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(within(row('Aarav Sharma')).getByRole('radio', { name: 'Completed' }));
    await user.click(within(row('Aarav Sharma')).getByRole('radio', { name: 'Correction required' }));
    await user.click(within(row('Bela Nair')).getByRole('radio', { name: 'Not completed' }));
    expect(screen.getByTestId('check-summary')).toHaveTextContent('3 of 3 checked');
    await user.click(screen.getByRole('button', { name: /Save checks/ }));
    await waitFor(() => expect(calls('mark_homework_checks')).toHaveLength(1));
    expect(calls('mark_homework_checks')[0]!.args).toMatchObject({
      p_assignment_id: M2.homework,
      p_observed_on: '2026-10-17',
      p_checks: [
        {
          student_id: M2.s1,
          completion: 'completed',
          correction: 'required',
          completed_on: null,
          comment: null,
          expected_version: null,
        },
        {
          student_id: M2.s2,
          completion: 'not_completed',
          correction: 'none',
          completed_on: null,
          comment: null,
          expected_version: null,
        },
      ],
    });
  });

  it('a principal-like role without checking rights sees the checks read-only', async () => {
    setCtx(CAPS.principal, 'principal');
    open((fn) => (fn === 'get_homework_roster' ? { data: homeworkRosterRow() } : null));
    await screen.findByTestId('homework-roster');
    expect(screen.getByText('You can see the checks but not change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save checks/ })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ diary conflict
describe('diary conflict reload', () => {
  beforeEach(() => setCtx(CAPS.teacher, 'teacher', { staff_id: M2.meera }));

  it('CONFLICT reloads and shows the newer text; the teacher keeps their own text to copy', async () => {
    const user = userEvent.setup();
    let entry = diaryEntryRow({ body: 'Fractions intro', version: 1 });
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_diary_entry') return { data: entry };
      if (fn === 'list_homework') return { data: { items: [], next_cursor: null } };
      if (fn === 'save_diary_entry') {
        entry = diaryEntryRow({ body: 'Fractions intro + worksheet (by Admin)', version: 2 });
        return hinted('CONFLICT', 'Someone else updated this diary entry. Reload to see it.');
      }
      return { data: null };
    });
    renderAt('/lessons/501', [{ path: '/lessons/:lessonId', element: <LessonPage /> }]);
    const box = await screen.findByLabelText('What was covered');
    expect(box).toHaveValue('Fractions intro');
    expect(screen.getByTestId('diary-meta')).toHaveTextContent('Lesson on 16 Oct 2026 · written');
    await user.clear(box);
    await user.type(box, 'Fractions: halves and quarters');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('save_diary_entry')).toHaveLength(1));
    expect(calls('save_diary_entry')[0]!.args).toMatchObject({
      p_lesson_session_id: 501,
      p_expected_version: 1,
    });
    // the newer text is loaded into the editor; mine is shown separately
    await waitFor(() =>
      expect(screen.getByLabelText('What was covered')).toHaveValue('Fractions intro + worksheet (by Admin)'),
    );
    expect(screen.getByTestId('diary-mine')).toHaveTextContent('Fractions: halves and quarters');
    await user.click(screen.getByRole('button', { name: 'Use my text instead' }));
    expect(screen.getByLabelText('What was covered')).toHaveValue('Fractions: halves and quarters');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('save_diary_entry')).toHaveLength(2));
    expect(calls('save_diary_entry')[1]!.args).toMatchObject({ p_expected_version: 2 });
  });
});

// ------------------------------------------------------------------ parent area
describe('parent / student area', () => {
  it('every child RPC uses the context child, never an id from the URL', async () => {
    setCtx(CAPS.parent, 'parent', { student_id: ids.child1 });
    onRpc((fn) => {
      if (fn === 'get_student_attendance_summary')
        return {
          data: {
            student_id: ids.child1,
            from: '2026-04-01',
            to: '2026-10-16',
            expected_units: 10,
            marked_units: 8,
            attended_units: 7,
            unmarked_units: 2,
            daily_units: 10,
            period_units: 0,
            marking_coverage_pct: 80,
            percentage: 87.5,
            is_final: false,
            percentage_basis: 'provisional_marked_only',
          },
        };
      if (
        fn === 'get_student_attendance_records' ||
        fn === 'get_student_diary' ||
        fn === 'get_student_homework'
      )
        return { data: [] };
      if (fn === 'get_schedule_range') return { data: [] };
      return { data: null };
    });
    renderAt(`/child?student=${ids.child2}`, [{ path: '/child', element: <ChildHomePage /> }]);
    expect(await screen.findByTestId('provisional')).toHaveTextContent('Provisional');
    expect(screen.getByText(/80% coverage/)).toBeInTheDocument();
    await waitFor(() => expect(calls('get_student_homework')).toHaveLength(1));
    const childCalls = rpcCalls.filter((c) => c.args && 'p_student_id' in c.args);
    expect(childCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of childCalls) expect(c.args!.p_student_id).toBe(ids.child1);
    // the week view sends no section/staff filter: the server scopes it to the child
    expect(calls('get_schedule_range')[0]!.args).not.toHaveProperty('p_section_id');
  });
});
