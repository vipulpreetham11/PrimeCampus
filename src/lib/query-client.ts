import { QueryClient } from '@tanstack/react-query';
import { isTransient } from './errors';

// Memory-only cache (CLAUDE.md rule 12): no persister is ever attached.
// Defaults reviewed per TRD §18: one retry for transient read failures only; mutations never auto-retry.

/**
 * An invalidation must always fetch again AFTER the write that caused it. TanStack Query cancels an
 * in-flight refetch on invalidation only when the query already has data (`cancelRefetch`); a query
 * still on its first load just reuses the in-flight request (query-core `Query.fetch`), so an answer
 * started BEFORE the write became the newest data and stayed for the whole stale time.
 * Found live (M4 review, the M2-3 flake): the lesson page's first list_homework was in flight while
 * the homework was saved; no list request followed, and the new homework never appeared.
 * So first loads that are in flight are cancelled (reverted) before invalidating.
 */
export class AppQueryClient extends QueryClient {
  override async invalidateQueries(...args: Parameters<QueryClient['invalidateQueries']>): Promise<void> {
    const [filters] = args;
    const firstLoads = this.getQueryCache()
      .findAll({ ...filters, fetchStatus: 'fetching' })
      .filter((q) => q.state.data === undefined);
    await Promise.all(firstLoads.map((q) => q.cancel({ revert: true })));
    return super.invalidateQueries(...args);
  }
}

export const queryClient = new AppQueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 1 && isTransient(error),
      retryDelay: 1000,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      networkMode: 'online',
    },
    // 'always': an offline save fails at once as NETWORK ("You appear to be offline… Nothing was
    // changed") and the user decides to retry. With 'online' it was paused silently ("Saving…") and
    // sent later on its own (found in M2X).
    mutations: { retry: false, networkMode: 'always' },
  },
});
