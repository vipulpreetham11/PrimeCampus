import { useState, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { contextSchema } from '@/contracts/session';
import { AppError } from '@/lib/errors';
import { emptyRoster, loadRoster, setValue, strictEquals, type RosterRow } from '@/lib/roster';
import { sessionStore } from '@/lib/session/store';
import { useRosterSave } from '@/lib/use-roster-save';
import { contextRow, fakeSupabase, ids, onRpc, resetFake, rpcCalls } from './fake-supabase';
import {
  CAPS,
  classSubjectsM2,
  diaryEntryRow,
  M2,
  snapshotM2,
  staffListM2,
  timetableVersionRow,
} from './m2-fixtures';

// M2 owner review fixes: roster batches keep their operation id by row ids; creates without an
// operation id (save_homework create, copy_timetable) look for the row after an uncertain failure.

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { LessonPage } = await import('@/features/diary/LessonPage');
const { TimetableEditorPage } = await import('@/features/timetable/TimetableEditorPage');

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const NETWORK_ERROR = { error: { message: 'TypeError: Failed to fetch' } };

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

// ------------------------------------------------------------------ roster batches
describe('roster save: batch operation ids follow the rows, not the batch position', () => {
  type V = 'P' | 'A';
  const eq = strictEquals as (a: V | null, b: V | null) => boolean;
  const ROWS = Array.from({ length: 150 }, (_, i) => ({
    id: `s${String(i + 1).padStart(3, '0')}`,
    value: null,
    version: null,
  }));

  it('150 rows, batch 2 fails with NETWORK: the retry sends batch 2 with the same operation id', async () => {
    const sent: { ids: string[]; operationId: string }[] = [];
    let failBatch2 = true;
    const send = vi.fn(async (rows: RosterRow<V>[], operationId: string) => {
      sent.push({ ids: rows.map((r) => r.id), operationId });
      if (rows[0]!.id === 's101' && failBatch2) {
        throw new AppError('NETWORK', 'No connection.', 'req-1');
      }
      return { conflicts: [] };
    });
    const { result } = renderHook(() => {
      const [roster, setRoster] = useState(() =>
        ROWS.reduce((r, row) => setValue(r, row.id, 'P' as V, eq), loadRoster(emptyRoster<V>(), ROWS, eq)),
      );
      const saver = useRosterSave<V>({
        setRoster,
        batchSize: 100,
        send,
        payloadOf: (rows) => rows.map((r) => [r.id, r.draft, r.baseVersion]),
        reload: async () => undefined,
      });
      return { roster, saver };
    });

    await act(() => result.current.saver.save(result.current.roster));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.ids).toHaveLength(100);
    expect(sent[1]!.ids).toEqual(ROWS.slice(100).map((r) => r.id));
    expect(result.current.saver.phase).toBe('not_saved');
    // batch 1 saved; only batch 2's 50 rows are still pending
    expect(result.current.roster.rows.s001!.draft).toBeNull();
    expect(result.current.roster.rows.s150!.draft).toBe('P');

    failBatch2 = false;
    await act(() => result.current.saver.save(result.current.roster));
    expect(sent).toHaveLength(3);
    // the retry is now the FIRST batch of its save, yet it gets batch 2's id back
    expect(sent[2]!.ids).toEqual(sent[1]!.ids);
    expect(sent[2]!.operationId).toBe(sent[1]!.operationId);
    expect(sent[2]!.operationId).not.toBe(sent[0]!.operationId);
    expect(result.current.saver.phase).toBe('saved');
  });
});

/** Holds replies until `release()` while `holding` is on, so an in-between state can be seen. */
function gate() {
  const waiting: (() => void)[] = [];
  return {
    holding: false,
    hold<T>(reply: T): T | Promise<T> {
      if (!this.holding) return reply;
      return new Promise<T>((resolve) => waiting.push(() => resolve(reply)));
    },
    get held() {
      return waiting.length;
    },
    release() {
      this.holding = false;
      waiting.splice(0).forEach((go) => go());
    },
  };
}

// ------------------------------------------------------------------ homework create
describe('set homework after an uncertain failure (save_homework create has no operation id)', () => {
  beforeEach(() => setCtx(CAPS.teacher, 'teacher', { staff_id: M2.meera }));

  const homeworkItem = (description: string, id = M2.homework) => ({
    assignment_id: id,
    section_id: M2.sectionA,
    section: 'Class 1 A',
    subject_id: M2.maths,
    subject: 'Mathematics',
    assigned_by_staff: M2.meera,
    assigned_by: 'Meera Rao',
    lesson_session_id: 501,
    assigned_on: '2026-10-16',
    due_on: '2026-10-17',
    description,
    status: 'active',
    version: 1,
    eligible: 3,
    checked: 0,
    completed: 0,
    not_completed: 0,
    correction_required: 0,
    can_edit: true,
    can_check: true,
  });

  const open = (handler: (fn: string) => unknown) => {
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_diary_entry') return { data: diaryEntryRow(null) };
      return (handler(fn) ?? { data: null }) as never;
    });
    renderAt('/lessons/501', [{ path: '/lessons/:lessonId', element: <LessonPage /> }]);
  };

  const setHomework = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.click(await screen.findByRole('button', { name: 'Set homework' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Homework'), text);
    await user.click(within(dialog).getByRole('button', { name: 'Set homework' }));
    return dialog;
  };

  it('NETWORK, then the homework is found in the lesson: "checking…", then treated as saved and closed', async () => {
    const user = userEvent.setup();
    const reads = gate();
    let created = false;
    open((fn) => {
      if (fn === 'save_homework') {
        created = true; // the server made it, but the reply was lost
        reads.holding = true;
        return NETWORK_ERROR;
      }
      if (fn === 'list_homework') {
        const items = created ? [homeworkItem('Exercise 4, page 12')] : [];
        return reads.hold({ data: { items, next_cursor: null } });
      }
      return null;
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, '  Exercise 4, page 12 ');

    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    // the teacher can't just press Save again while we don't know
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeDisabled();
    await waitFor(() => expect(reads.held).toBeGreaterThan(0));
    act(() => reads.release());

    expect(await screen.findByText('Homework set.')).toBeInTheDocument();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(1);
    // the look-up read the lesson's day and section
    expect(calls('list_homework').at(-1)!.args).toMatchObject({
      p_from: '2026-10-16',
      p_to: '2026-10-16',
      p_section_id: M2.sectionA,
      p_status: 'active',
    });
  });

  it('NETWORK, then nothing found: "Wasn\'t saved — try again", and only then Save works again', async () => {
    const user = userEvent.setup();
    const reads = gate();
    let saveFails = true;
    open((fn) => {
      if (fn === 'save_homework') {
        if (!saveFails) return { data: { assignment_id: M2.homework, version: 1 } };
        reads.holding = true;
        return NETWORK_ERROR;
      }
      if (fn === 'list_homework') return reads.hold({ data: { items: [], next_cursor: null } });
      return null;
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, 'Read chapter 3');

    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeDisabled();
    await waitFor(() => expect(reads.held).toBeGreaterThan(0));
    act(() => reads.release());

    expect(await within(dialog).findByText("Wasn't saved — try again.")).toBeInTheDocument();
    const again = within(dialog).getByRole('button', { name: 'Set homework' });
    expect(again).toBeEnabled();
    saveFails = false;
    await user.click(again);
    // (a toast from an earlier test may still be on screen: look for at least one)
    expect((await screen.findAllByText('Homework set.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(2);
  });

  it('the look-up fails too: still not confirmed, Save stays disabled, "Check again" re-runs it', async () => {
    const user = userEvent.setup();
    let listDown = false;
    let created = false;
    open((fn) => {
      if (fn === 'save_homework') {
        listDown = true;
        created = true;
        return NETWORK_ERROR;
      }
      if (fn === 'list_homework') {
        if (listDown) return NETWORK_ERROR;
        return { data: { items: created ? [homeworkItem('Read chapter 3')] : [], next_cursor: null } };
      }
      return null;
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, 'Read chapter 3');
    expect(await within(dialog).findByText(/we couldn.t check whether it was saved/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeDisabled();

    listDown = false;
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }));
    // (a toast from an earlier test may still be on screen: look for at least one)
    expect((await screen.findAllByText('Homework set.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(1);
  });

  it('homework the lesson already had (same text) is not mistaken for the new one', async () => {
    const user = userEvent.setup();
    const existing = homeworkItem('Read chapter 3', '40404040-0000-4000-8000-0000000000aa');
    open((fn) => {
      if (fn === 'save_homework') return NETWORK_ERROR;
      if (fn === 'list_homework') return { data: { items: [existing], next_cursor: null } };
      return null;
    });
    await screen.findByTestId('lesson-homework');
    const dialog = await setHomework(user, 'Read chapter 3');
    expect(await within(dialog).findByText("Wasn't saved — try again.")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ copy timetable
describe('copy a timetable after an uncertain failure (copy_timetable has no operation id)', () => {
  const COPY = '7e7e7e7e-0000-4000-8000-0000000000c0';
  const OLD_DRAFT = '7e7e7e7e-0000-4000-8000-0000000000d0';
  const versionRow = (id: string, from: string) => ({
    timetable_version_id: id,
    status: 'draft',
    effective_from: from,
    effective_to: null,
    period_schedule_id: M2.schedule,
    period_schedule: 'Regular day',
    copied_from_id: M2.version,
    version: 1,
    updated_at: '2026-10-16T10:00:00+05:30',
    entry_count: 2,
    unassigned_teacher_count: 2,
  });

  /** Class 1 B already has a draft copied from this timetable; `state.copiedOn` adds the new one. */
  const open = (onCopy: (args: Record<string, unknown>) => unknown) => {
    const reads = gate();
    const state = { copiedOn: null as string | null };
    onRpc((fn, args) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_timetable_version') {
        return {
          data:
            args?.p_version_id === COPY
              ? timetableVersionRow({
                  timetable_version_id: COPY,
                  section_id: M2.sectionB,
                  section: 'Class 1 B',
                })
              : timetableVersionRow({ status: 'active', can_edit: false, conflicts: [] }),
        };
      }
      if (fn === 'list_timetable_versions') {
        const rows = [versionRow(OLD_DRAFT, '2026-10-12')];
        if (state.copiedOn) rows.unshift(versionRow(COPY, state.copiedOn));
        return reads.hold({ data: rows });
      }
      if (fn === 'copy_timetable') {
        reads.holding = true;
        return onCopy(args!) as never;
      }
      return { data: null };
    });
    const r = renderAt(`/timetable/${M2.version}`, [
      { path: '/timetable/:versionId', element: <TimetableEditorPage /> },
    ]);
    return { ...r, reads, state };
  };

  const startCopy = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /Copy to another section/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Copy to' }));
    await user.click(await screen.findByRole('option', { name: /1 B/ }));
    const copy = within(dialog).getByRole('button', { name: 'Copy' });
    // enabled once the target's current versions are known
    await waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    return dialog;
  };

  it('NETWORK, then the new draft is in the target section: "checking…", then treated as copied and opened', async () => {
    const user = userEvent.setup();
    const { router, reads, state } = open((args) => {
      state.copiedOn = args.p_effective_from as string; // made, but the reply was lost
      return NETWORK_ERROR;
    });
    const dialog = await startCopy(user);
    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeDisabled();
    await waitFor(() => expect(reads.held).toBeGreaterThan(0));
    act(() => reads.release());

    await waitFor(() => expect(router.state.location.pathname).toBe(`/timetable/${COPY}`));
    expect(calls('copy_timetable')).toHaveLength(1);
    expect(calls('copy_timetable')[0]!.args).toMatchObject({
      p_from_version_id: M2.version,
      p_target_section_id: M2.sectionB,
    });
    expect(calls('list_timetable_versions').at(-1)!.args).toMatchObject({ p_section_id: M2.sectionB });
  });

  it('NETWORK, then no new draft (the older one does not count): "Wasn\'t saved — try again", then retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { reads } = open(() =>
      fail ? NETWORK_ERROR : { data: { timetable_version_id: COPY, status: 'draft', conflicts: [] } },
    );
    const dialog = await startCopy(user);
    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeDisabled();
    await waitFor(() => expect(reads.held).toBeGreaterThan(0));
    act(() => reads.release());

    expect(await within(dialog).findByText("Wasn't saved — try again.")).toBeInTheDocument();
    const again = within(dialog).getByRole('button', { name: 'Copy' });
    expect(again).toBeEnabled();
    fail = false;
    await user.click(again);
    await waitFor(() => expect(calls('copy_timetable')).toHaveLength(2));
  });
});
