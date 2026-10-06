import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, onRpc, resetFake, rpcCalls } from './fake-supabase';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));
const t = await import('@/lib/telemetry');

const pageViews = () => rpcCalls.filter((c) => c.fn === 'record_telemetry');

beforeEach(() => {
  vi.useFakeTimers();
  resetFake();
  onRpc(() => ({ data: { accepted: 1 } }));
  t.setTelemetryEnabled(true);
});
afterEach(() => {
  t.setTelemetryEnabled(false);
  vi.useRealTimers();
});

describe('telemetry batching', () => {
  it('sends at most 20 events per request', async () => {
    for (let i = 0; i < 45; i++) t.trackPageView(`/p${i}`);
    await vi.advanceTimersByTimeAsync(0);
    await t.flushTelemetry();
    await t.flushTelemetry();
    for (const c of pageViews()) expect((c.args?.p_events as unknown[]).length).toBeLessThanOrEqual(20);
    expect(pageViews().reduce((n, c) => n + (c.args?.p_events as unknown[]).length, 0)).toBe(45);
  });

  it('flushes every 60 s', async () => {
    t.trackPageView('/dashboard');
    expect(pageViews()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(t.FLUSH_INTERVAL_MS);
    expect(pageViews()).toHaveLength(1);
    const ev = (pageViews()[0]!.args?.p_events as Record<string, unknown>[])[0]!;
    expect(ev).toMatchObject({ event: 'page_view', path: '/dashboard' });
    expect(pageViews()[0]!.args?.p_ctx_rev).toBeUndefined();
  });

  it('flushes when the page is hidden', async () => {
    t.trackPageView('/choose');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pageViews()).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('never throws or blocks when the server rejects the batch', async () => {
    onRpc(() => ({ error: { message: 'TypeError: Failed to fetch' } }));
    t.trackPageView('/x');
    await expect(t.flushTelemetry()).resolves.toBeUndefined();
    expect(t._queueLength()).toBe(0);
  });

  it('records nothing while disabled and strips ids from paths', () => {
    t.setTelemetryEnabled(false);
    t.trackPageView('/students/22222222-2222-4222-8222-222222222222');
    expect(t._queueLength()).toBe(0);
    expect(t.normalizePath('/students/22222222-2222-4222-8222-222222222222/fees/12?x=1')).toBe(
      '/students/:id/fees/:n',
    );
  });
});
