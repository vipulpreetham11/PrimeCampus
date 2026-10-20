import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AppQueryClient } from '@/lib/query-client';

// The M2-3 flake (M4 review): a write that settles while a query is still on its FIRST fetch. Plain
// TanStack reuses the in-flight request, so the answer started before the write wins. AppQueryClient
// cancels that first load and fetches again.

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function scenario(qc: QueryClient) {
  const answers = [deferred<string>(), deferred<string>()];
  let calls = 0;
  const observer = new QueryObserver(qc, {
    queryKey: ['homework-list'],
    queryFn: ({ signal }) => {
      const i = calls++;
      signal.addEventListener('abort', () => answers[i]!.resolve('aborted'));
      return answers[i]!.promise;
    },
    staleTime: 30_000,
  });
  const unsubscribe = observer.subscribe(() => undefined); // an active query, as on the lesson page
  await Promise.resolve();
  expect(calls).toBe(1); // first load in flight (started before the write)
  // the write settles now → its invalidation
  const invalidated = qc.invalidateQueries({ queryKey: ['homework-list'] });
  answers[0]!.resolve('old list (no new homework)');
  answers[1]!.resolve('new list (with the homework)');
  await invalidated;
  await qc.getQueryCache().find({ queryKey: ['homework-list'] })!.promise;
  const data = qc.getQueryData<string>(['homework-list']);
  unsubscribe();
  return { calls, data };
}

describe('invalidation during a first load', () => {
  it('plain QueryClient: the in-flight answer started before the write wins (the bug)', async () => {
    const r = await scenario(new QueryClient());
    expect(r.calls).toBe(1);
    expect(r.data).toBe('old list (no new homework)');
  });

  it('AppQueryClient: the first load is cancelled and the list is fetched again after the write', async () => {
    const r = await scenario(new AppQueryClient());
    expect(r.calls).toBe(2);
    expect(r.data).toBe('new list (with the homework)');
  });
});
