import { QueryClient } from '@tanstack/react-query';
import { isTransient } from './errors';

// Memory-only cache (CLAUDE.md rule 12): no persister is ever attached.
// Defaults reviewed per TRD §18: one retry for transient read failures only; mutations never auto-retry.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 1 && isTransient(error),
      retryDelay: 1000,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      networkMode: 'online',
    },
    mutations: { retry: false, networkMode: 'online' },
  },
});
