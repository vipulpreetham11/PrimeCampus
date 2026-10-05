import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapRow, contextRow, fakeSupabase, ids, onRpc, resetFake, rpcCalls } from './fake-supabase';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const session = await import('@/lib/session/session');
const { sessionStore } = await import('@/lib/session/store');
const { queryClient } = await import('@/lib/query-client');
const { scopedKey } = await import('@/contracts/query-keys');
const rpc = await import('@/lib/rpc');
const { contextSchema } = await import('@/contracts/session');
const { redirectFor } = await import('@/app/gate');

const flush = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await flush();
  expect(cond()).toBe(true);
};

function seedCache(revision: number) {
  const key = scopedKey(
    { accountId: ids.account, revision, schoolId: ids.school, role: 'admin', studentId: null },
    'students',
  );
  queryClient.setQueryData(key, [{ name: 'cached student' }]);
  return key;
}

let otherTab: BroadcastChannel;
const tabMessages: unknown[] = [];

beforeAll(async () => {
  resetFake();
  await session.initSession(); // registers global handlers + BroadcastChannel
  otherTab = new BroadcastChannel('primecampus-session');
  otherTab.onmessage = (e) => tabMessages.push(e.data);
});
afterAll(() => otherTab.close());

beforeEach(() => {
  resetFake();
  queryClient.clear();
  sessionStore.reset();
  sessionStore.set({ status: 'choosing' });
  tabMessages.length = 0;
});

describe('context switch', () => {
  it('cancels in-flight requests, clears the cache and broadcasts the new revision', async () => {
    sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(4)) });
    const key = seedCache(4);
    const epochBefore = sessionStore.get().epoch;

    let rev = 4;
    onRpc((fn) => {
      if (fn === 'get_setup_snapshot') return new Promise(() => undefined); // never answers
      if (fn === 'select_context')
        return {
          data: {
            context_revision: ++rev,
            school_id: ids.school,
            role: 'admin',
            student_id: null,
            membership_id: ids.membership,
          },
        };
      if (fn === 'get_context') return { data: contextRow(rev) };
      return { data: null };
    });
    const inFlight = rpc.getSetupSnapshot();

    await session.chooseContext({ membershipId: ids.membership2 });

    await expect(inFlight).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionStore.get().epoch).toBeGreaterThan(epochBefore); // keyed UI remounts → drafts gone
    expect(sessionStore.get().context?.context_revision).toBe(5);
    expect(rpcCalls.find((c) => c.fn === 'select_context')?.args).toEqual({
      p_membership_id: ids.membership2,
    });
    await waitFor(() => tabMessages.some((m) => (m as { type: string }).type === 'context'));
    expect(tabMessages).toContainEqual({ type: 'context', revision: 5 });
  });

  it('sends the child for a parent context', async () => {
    onRpc((fn) =>
      fn === 'select_context'
        ? {
            data: {
              context_revision: 2,
              school_id: ids.school,
              role: 'parent',
              student_id: ids.child1,
              membership_id: ids.membership,
            },
          }
        : { data: { ...contextRow(2, 'parent', []), student_id: ids.child1 } },
    );
    await session.chooseContext({ membershipId: ids.membership, studentId: ids.child1 });
    expect(rpcCalls[0]?.args).toEqual({ p_membership_id: ids.membership, p_student_id: ids.child1 });
    expect(sessionStore.get().context?.student_id).toBe(ids.child1);
  });

  it('operator context sends only the school', async () => {
    onRpc((fn) =>
      fn === 'select_context'
        ? {
            data: {
              context_revision: 9,
              school_id: ids.school,
              role: 'operator',
              student_id: null,
              membership_id: null,
            },
          }
        : { data: { ...contextRow(9, 'operator'), via_operator: true } },
    );
    await session.chooseContext({ operatorSchoolId: ids.school });
    expect(rpcCalls[0]?.args).toEqual({ p_operator_school_id: ids.school });
    expect(sessionStore.get().context?.via_operator).toBe(true);
  });
});

describe('STALE_CONTEXT', () => {
  it('a forced stale revision shows the "role/school changed" message and recovers', async () => {
    sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(10)) });
    const key = seedCache(10);
    onRpc((fn, args) => {
      if (fn === 'get_setup_snapshot') {
        return args?.p_ctx_rev === 11
          ? { data: { ok: true } }
          : {
              error: {
                code: 'P0001',
                hint: 'STALE_CONTEXT',
                message: 'Your role/school/child selection changed.',
              },
            };
      }
      if (fn === 'get_context') return { data: contextRow(11) };
      return { data: null };
    });

    await expect(rpc.getSetupSnapshot()).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
    await waitFor(() => sessionStore.get().context?.context_revision === 11);

    expect(sessionStore.get().status).toBe('ready');
    expect(sessionStore.get().notice?.message).toMatch(
      /Your role\/school changed\. You are now viewing Admin — Demo School/,
    );
    expect(queryClient.getQueryData(key)).toBeUndefined();
    // recovered: the next call uses the server's revision and succeeds
    await expect(rpc.getSetupSnapshot()).resolves.toEqual({ ok: true });
    expect(rpcCalls.at(-1)?.args?.p_ctx_rev).toBe(11);
  });

  it('another tab switching context makes this tab adopt it', async () => {
    sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(20)) });
    onRpc(() => ({ data: contextRow(21, 'teacher', []) }));
    otherTab.postMessage({ type: 'context', revision: 21 });
    await waitFor(() => sessionStore.get().context?.context_revision === 21);
    expect(sessionStore.get().context?.role).toBe('teacher');
    expect(sessionStore.get().notice?.message).toMatch(/changed in another tab/);
  });
});

describe('logout', () => {
  it('ends the app session, signs out, clears the cache and tells other tabs', async () => {
    sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(3)) });
    seedCache(3);
    onRpc(() => ({ data: { ended: true } }));
    await session.logout();
    expect(rpcCalls.map((c) => c.fn)).toContain('end_app_session');
    expect(fakeSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionStore.get()).toMatchObject({ status: 'signed_out', account: null, context: null });
    await waitFor(() => tabMessages.some((m) => (m as { type: string }).type === 'logout'));
  });

  it('still signs out locally if end_app_session fails (offline)', async () => {
    onRpc(() => ({ error: { message: 'TypeError: Failed to fetch' } }));
    await session.logout();
    expect(fakeSupabase.auth.signOut).toHaveBeenCalled();
    expect(sessionStore.get().status).toBe('signed_out');
  });

  it('a logout broadcast from another tab signs this tab out', async () => {
    sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(3)) });
    seedCache(3);
    otherTab.postMessage({ type: 'logout' });
    await waitFor(() => sessionStore.get().status === 'signed_out');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionStore.get().notice?.message).toMatch(/signed out in another tab/);
  });
});

describe('sign in', () => {
  it('uses the internal alias and bootstraps', async () => {
    onRpc((fn) => {
      if (fn === 'bootstrap_account') return { data: bootstrapRow() };
      if (fn === 'select_context')
        return {
          data: {
            context_revision: 1,
            school_id: ids.school,
            role: 'admin',
            student_id: null,
            membership_id: ids.membership,
          },
        };
      return { data: contextRow(1) };
    });
    await session.signIn('  Demo.Admin ', 'secret-pass');
    expect(fakeSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'demo.admin@login.example.test',
      password: 'secret-pass',
    });
    // single context → entered directly
    expect(sessionStore.get().status).toBe('ready');
  });

  it('shows the same generic error for unknown users, wrong passwords and malformed usernames', async () => {
    fakeSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 400, message: 'Invalid login credentials' },
    });
    const wrong = await session.signIn('demo.admin', 'nope').catch((e: Error) => e.message);
    const unknown = await session.signIn('no.such.user', 'nope').catch((e: Error) => e.message);
    const malformed = await session.signIn('a', 'nope').catch((e: Error) => e.message);
    expect(wrong).toBe(session.GENERIC_SIGN_IN_ERROR);
    expect(unknown).toBe(wrong);
    expect(malformed).toBe(wrong);
    expect(fakeSupabase.auth.signInWithPassword).toHaveBeenCalledTimes(2); // malformed never hits Auth
  });

  it('must_change_password locks the user to change-password', async () => {
    onRpc(() => ({ data: bootstrapRow({ must_change_password: true, contexts: [] }) }));
    await session.signIn('demo.admin', 'temp-pass');
    expect(sessionStore.get().status).toBe('must_change_password');
    for (const path of ['/dashboard', '/choose', '/operator/onboarding', '/sign-in', '/']) {
      expect(redirectFor('must_change_password', path, true)).toBe('/change-password');
    }
    expect(redirectFor('must_change_password', '/change-password', true)).toBeNull();
  });

  it('multi-child parents go to the chooser instead of entering directly', () => {
    const parent = {
      membership_id: ids.membership,
      school_id: ids.school,
      school_name: 'Demo School',
      role: 'parent' as const,
      children: [
        { student_id: ids.child1, name: 'A', class_section: '5 A' },
        { student_id: ids.child2, name: 'B', class_section: '2 B' },
      ],
    };
    expect(session.automaticChoice([parent], false)).toBeNull();
    expect(session.automaticChoice([{ ...parent, children: [parent.children[0]!] }], false)).toEqual({
      membershipId: ids.membership,
      studentId: ids.child1,
    });
    expect(session.automaticChoice([{ ...parent, role: 'teacher', children: null }], false)).toEqual({
      membershipId: ids.membership,
    });
    expect(session.automaticChoice([{ ...parent, role: 'teacher', children: null }], true)).toBeNull();
  });
});

describe('route gate', () => {
  it('sends signed-out users to sign-in and ready users away from it', () => {
    expect(redirectFor('signed_out', '/dashboard', false)).toBe('/sign-in');
    expect(redirectFor('ready', '/sign-in', false)).toBe('/dashboard');
    expect(redirectFor('choosing', '/dashboard', false)).toBe('/choose');
    expect(redirectFor('choosing', '/operator/onboarding', false)).toBe('/choose');
    expect(redirectFor('choosing', '/operator/onboarding', true)).toBeNull();
  });
});
