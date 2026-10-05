import { vi } from 'vitest';

// In-memory stand-in for the supabase-js client used by src/lib/*. Records every RPC call.
export interface RpcCall {
  fn: string;
  args: Record<string, unknown> | undefined;
}
type Reply = { data?: unknown; error?: unknown };
type Handler = (fn: string, args: Record<string, unknown> | undefined) => Reply | Promise<Reply>;

export const rpcCalls: RpcCall[] = [];
let handler: Handler = () => ({ data: null });

export function onRpc(h: Handler) {
  handler = h;
}

export function resetFake() {
  rpcCalls.length = 0;
  handler = () => ({ data: null });
  fakeSupabase.auth.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  fakeSupabase.auth.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
  fakeSupabase.auth.signOut.mockReset().mockResolvedValue({ error: null });
  fakeSupabase.functions.invoke.mockReset();
}

export const fakeSupabase = {
  rpc(fn: string, args?: Record<string, unknown>) {
    return {
      abortSignal(signal: AbortSignal) {
        rpcCalls.push({ fn, args });
        return new Promise<{ data: unknown; error: unknown }>((resolve, reject) => {
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          void Promise.resolve(handler(fn, args)).then((r) => {
            if (signal.aborted) return;
            resolve({ data: r.data ?? null, error: r.error ?? null });
          });
        });
      },
    };
  },
  auth: {
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
  },
  functions: { invoke: vi.fn() },
};

export const ids = {
  account: '11111111-1111-4111-8111-111111111111',
  school: '22222222-2222-4222-8222-222222222222',
  membership: '33333333-3333-4333-8333-333333333333',
  membership2: '44444444-4444-4444-8444-444444444444',
  child1: '55555555-5555-4555-8555-555555555555',
  child2: '66666666-6666-4666-8666-666666666666',
  year: '77777777-7777-4777-8777-777777777777',
};

export function contextRow(revision: number, role = 'admin', capabilities: string[] = ['setup.manage']) {
  return {
    school_id: ids.school,
    school_name: 'Demo School',
    role,
    via_operator: false,
    student_id: null,
    staff_id: null,
    context_revision: revision,
    current_year: { id: ids.year, name: '2026-27', start_date: '2026-06-01', end_date: '2027-03-31' },
    capabilities,
  };
}

export function bootstrapRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ids.account,
    username: 'demo.admin',
    display_name: 'Demo Admin',
    must_change_password: false,
    is_operator: false,
    new_session: true,
    contexts: [
      {
        membership_id: ids.membership,
        school_id: ids.school,
        school_name: 'Demo School',
        role: 'admin',
        children: null,
      },
    ],
    selected: { membership_id: null, operator_school_id: null, student_id: null, context_revision: 0 },
    ...overrides,
  };
}
