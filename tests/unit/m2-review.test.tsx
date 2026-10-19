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
// operation id (save_homework create, copy_timetable) are re-sent after an uncertain failure and
// resolved by the 2310 DUPLICATE (M2X).

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

const DUPLICATE_HOMEWORK = {
  error: {
    code: 'P0001',
    hint: 'DUPLICATE',
    message: 'This homework is already set for this lesson',
    details: JSON.stringify({ assignment_id: M2.homework, version: 1 }),
  },
};

// ------------------------------------------------------------------ homework create
// M2X: since migration 2310 the same lesson + text again is DUPLICATE with the homework's id, so
// after an uncertain failure the dialog re-sends the same request instead of searching the list.
describe('set homework after an uncertain failure (save_homework create has no operation id)', () => {
  beforeEach(() => setCtx(CAPS.teacher, 'teacher', { staff_id: M2.meera }));

  const open = (handler: (fn: string) => unknown) => {
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_diary_entry') return { data: diaryEntryRow(null) };
      if (fn === 'list_homework') return { data: { items: [], next_cursor: null } };
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

  it('NETWORK, then the re-sent request is DUPLICATE: "checking…", then treated as saved and closed', async () => {
    const user = userEvent.setup();
    const replies = gate();
    let attempt = 0;
    open((fn) => {
      if (fn !== 'save_homework') return null;
      attempt += 1;
      if (attempt === 1) {
        replies.holding = true; // the server made it, but the reply was lost
        return NETWORK_ERROR;
      }
      return replies.hold(DUPLICATE_HOMEWORK);
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, '  Exercise 4, page 12 ');

    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    // the teacher can't change or re-send anything while we don't know
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeDisabled();
    await waitFor(() => expect(replies.held).toBeGreaterThan(0));
    act(() => replies.release());

    expect((await screen.findAllByText('Homework set.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const sent = calls('save_homework');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.args).toEqual(sent[0]!.args); // the same request, trimmed text
    expect(sent[0]!.args).toMatchObject({ p_lesson_session_id: 501, p_description: 'Exercise 4, page 12' });
  });

  it('NETWORK, and the first request never arrived: the re-send creates it', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    open((fn) => {
      if (fn !== 'save_homework') return null;
      attempt += 1;
      return attempt === 1 ? NETWORK_ERROR : { data: { assignment_id: M2.homework, version: 1 } };
    });
    await screen.findByText('No homework set in this lesson');
    await setHomework(user, 'Read chapter 3');
    expect((await screen.findAllByText('Homework set.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(2);
  });

  it('the re-send fails uncertainly too: still not confirmed, Save stays disabled, "Check again" re-sends', async () => {
    const user = userEvent.setup();
    let down = true;
    open((fn) => {
      if (fn !== 'save_homework') return null;
      return down ? NETWORK_ERROR : DUPLICATE_HOMEWORK;
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, 'Read chapter 3');
    expect(await within(dialog).findByText(/we couldn.t check whether it was saved/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeDisabled();
    expect(calls('save_homework')).toHaveLength(2);

    down = false;
    await user.click(within(dialog).getByRole('button', { name: 'Check again' }));
    expect((await screen.findAllByText('Homework set.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(3);
  });

  it('DUPLICATE on the first press: "Already set for this lesson", nothing new, dialog closed', async () => {
    const user = userEvent.setup();
    open((fn) => (fn === 'save_homework' ? DUPLICATE_HOMEWORK : null));
    await screen.findByText('No homework set in this lesson');
    await setHomework(user, 'Read chapter 3');
    expect(await screen.findByText('Already set for this lesson.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('save_homework')).toHaveLength(1);
  });

  it('the re-send is refused (the lesson was cancelled meanwhile): the message shows, Save works again', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    open((fn) => {
      if (fn !== 'save_homework') return null;
      attempt += 1;
      return attempt === 1
        ? NETWORK_ERROR
        : { error: { code: 'P0001', hint: 'VALIDATION_ERROR', message: 'Lesson was cancelled' } };
    });
    await screen.findByText('No homework set in this lesson');
    const dialog = await setHomework(user, 'Read chapter 3');
    expect(await within(dialog).findByText('Lesson was cancelled')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set homework' })).toBeEnabled();
    expect(within(dialog).queryByTestId('create-check')).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ copy timetable
describe('copy a timetable (copy_timetable has no operation id; 2310 DUPLICATE names the draft)', () => {
  const COPY = '7e7e7e7e-0000-4000-8000-0000000000c0';
  const duplicateDraft = {
    error: {
      code: 'P0001',
      hint: 'DUPLICATE',
      message: 'This section already has a draft starting on this date. Open it instead.',
      details: JSON.stringify({ timetable_version_id: COPY }),
    },
  };

  const open = (onCopy: (args: Record<string, unknown>, attempt: number) => unknown) => {
    const replies = gate();
    let attempt = 0;
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
      if (fn === 'list_timetable_versions') return { data: [] };
      if (fn === 'copy_timetable') {
        attempt += 1;
        const reply = onCopy(args!, attempt);
        // only re-sends are held, so the first reply (NETWORK) arrives at once
        return (attempt === 1 ? reply : replies.hold(reply)) as never;
      }
      return { data: null };
    });
    const r = renderAt(`/timetable/${M2.version}`, [
      { path: '/timetable/:versionId', element: <TimetableEditorPage /> },
    ]);
    return { ...r, replies };
  };

  const startCopy = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /Copy to another section/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Copy to' }));
    await user.click(await screen.findByRole('option', { name: /1 B/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    return dialog;
  };

  it('NETWORK, then the re-sent copy is DUPLICATE: "checking…", then the earlier copy opens', async () => {
    const user = userEvent.setup();
    const { router, replies } = open((_args, attempt) => {
      if (attempt === 1) {
        replies.holding = true; // made, but the reply was lost
        return NETWORK_ERROR;
      }
      return duplicateDraft;
    });
    const dialog = await startCopy(user);
    expect(await within(dialog).findByText('Not confirmed — checking…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeDisabled();
    await waitFor(() => expect(replies.held).toBeGreaterThan(0));
    act(() => replies.release());

    await waitFor(() => expect(router.state.location.pathname).toBe(`/timetable/${COPY}`));
    const sent = calls('copy_timetable');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.args).toEqual(sent[0]!.args);
    expect(sent[0]!.args).toMatchObject({ p_from_version_id: M2.version, p_target_section_id: M2.sectionB });
  });

  it('DUPLICATE on the first press: "already has a draft starting on …" + Open it', async () => {
    const user = userEvent.setup();
    const { router } = open(() => duplicateDraft);
    const dialog = await startCopy(user);
    const notice = await within(dialog).findByTestId('existing-draft');
    expect(notice).toHaveTextContent(/This section already has a draft starting on /);
    expect(router.state.location.pathname).toBe(`/timetable/${M2.version}`); // nothing opened by itself
    await user.click(within(notice).getByRole('button', { name: 'Open it' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/timetable/${COPY}`));
    expect(calls('copy_timetable')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ activate with the version
describe('activate a draft with its version (2310 activate_timetable p_expected_version)', () => {
  const open = (onActivate: () => unknown) => {
    let reads = 0;
    onRpc((fn) => {
      const base = baseReads(fn);
      if (base) return base;
      if (fn === 'get_timetable_version') {
        reads += 1;
        return { data: timetableVersionRow({ conflicts: [], version: reads === 1 ? 3 : 4 }) };
      }
      if (fn === 'list_timetable_versions') return { data: [] };
      if (fn === 'activate_timetable') return onActivate() as never;
      return { data: null };
    });
    return renderAt(`/timetable/${M2.version}`, [
      { path: '/timetable/:versionId', element: <TimetableEditorPage /> },
    ]);
  };

  it('sends the draft version; CONFLICT without a clash list reloads the draft', async () => {
    const user = userEvent.setup();
    open(() => ({
      error: { code: 'P0001', hint: 'CONFLICT', message: 'This draft changed since you opened it' },
    }));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls('activate_timetable')).toHaveLength(1));
    expect(calls('activate_timetable')[0]!.args).toMatchObject({
      p_version_id: M2.version,
      p_expected_version: 3,
    });
    expect(await screen.findByText(/Someone else changed this draft/)).toBeInTheDocument();
    await waitFor(() => expect(calls('get_timetable_version').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/double-booked/)).not.toBeInTheDocument();
  });

  it('replayed: true counts as activated', async () => {
    const user = userEvent.setup();
    open(() => ({ data: { timetable_version_id: M2.version, status: 'active', replayed: true } }));
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Timetable activated.')).toBeInTheDocument();
  });
});
