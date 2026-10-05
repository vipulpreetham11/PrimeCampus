import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, onRpc, resetFake, rpcCalls, contextRow } from './fake-supabase';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const rpc = await import('@/lib/rpc');
const { sessionStore } = await import('@/lib/session/store');
const { AppError } = await import('@/lib/errors');
const { contextSchema } = await import('@/contracts/session');

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function setContext(revision: number) {
  sessionStore.set({ status: 'ready', context: contextSchema.parse(contextRow(revision)) });
}

beforeEach(() => {
  resetFake();
  sessionStore.reset();
});

describe('typed wrapper coverage', () => {
  const types = readFileSync(
    path.resolve(import.meta.dirname, '../../src/generated/database.types.ts'),
    'utf8',
  );
  const block = types.slice(types.indexOf('    Functions: {'), types.indexOf('    Enums: {'));
  const all = [...block.matchAll(/^ {6}([a-z_0-9]+): \{/gm)].map((m) => m[1]!);
  const browser = all.filter((n) => !n.startsWith('svc_'));

  it('has one wrapper for every browser-callable RPC in public', () => {
    expect(browser.length).toBeGreaterThan(90);
    for (const name of browser) expect(typeof (rpc as Record<string, unknown>)[camel(name)]).toBe('function');
    expect([...rpc.SCHOOL_RPCS, ...rpc.CONTEXTLESS_RPCS].sort()).toEqual([...browser].sort());
  });

  it('exposes no wrapper for service-role-only svc_* functions', () => {
    for (const name of all.filter((n) => n.startsWith('svc_'))) {
      expect((rpc as Record<string, unknown>)[camel(name)]).toBeUndefined();
    }
  });

  it('context-free RPCs are exactly the CLAUDE.md rule 2 exceptions', () => {
    const allowed = [
      'bootstrap_account',
      'select_context',
      'end_app_session',
      'get_context',
      'record_telemetry',
    ];
    for (const n of rpc.CONTEXTLESS_RPCS) expect(allowed.includes(n) || n.startsWith('op_')).toBe(true);
  });
});

describe('context revision', () => {
  it('is sent as p_ctx_rev on EVERY school RPC', async () => {
    setContext(7);
    onRpc(() => ({ data: {} }));
    for (const name of rpc.SCHOOL_RPCS) {
      const wrapper = (rpc as unknown as Record<string, (a: object) => Promise<unknown>>)[camel(name)]!;
      await wrapper({});
    }
    expect(rpcCalls).toHaveLength(rpc.SCHOOL_RPCS.length);
    for (const call of rpcCalls) expect(call.args?.p_ctx_rev).toBe(7);
  });

  it('is never sent on context-free RPCs', async () => {
    onRpc((fn) => ({
      data: fn === 'op_list_schools' ? [] : fn === 'end_app_session' ? { ended: true } : {},
    }));
    await rpc.endAppSession().catch(() => undefined);
    await rpc.opListSchools();
    for (const call of rpcCalls) expect(call.args?.p_ctx_rev).toBeUndefined();
  });

  it('school RPCs refuse to run without a selected context', async () => {
    await expect(rpc.getSetupSnapshot()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('caller args are passed through alongside the revision', async () => {
    setContext(3);
    onRpc(() => ({ data: {} }));
    await rpc.getTeacherToday({ p_date: '2026-10-05' });
    expect(rpcCalls[0]).toEqual({ fn: 'get_teacher_today', args: { p_date: '2026-10-05', p_ctx_rev: 3 } });
  });
});

describe('error and response handling', () => {
  it('maps error.hint to AppError codes', async () => {
    setContext(1);
    onRpc(() => ({ error: { code: 'P0001', hint: 'CONFLICT', message: 'version mismatch' } }));
    const err = await rpc.getSetupSnapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'CONFLICT' });
  });

  it('validates responses of RPCs with a contract schema', async () => {
    onRpc(() => ({ data: { school_id: 'not-a-uuid' } }));
    await expect(rpc.getContext()).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('drops a response that arrives after a context switch', async () => {
    setContext(1);
    let release!: () => void;
    onRpc(() => new Promise((r) => (release = () => r({ data: { stale: true } }))));
    const pending = rpc.getSetupSnapshot();
    sessionStore.nextEpoch(); // what a role/school/child switch does
    release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
