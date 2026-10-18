import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { contextSchema } from '@/contracts/session';
import { sessionStore } from '@/lib/session/store';
import { contextRow, ids } from './fake-supabase';

/** Put the session store in a ready context with exactly these capabilities. */
export function setContext(capabilities: string[], role = 'admin', revision = 1) {
  sessionStore.reset();
  sessionStore.set({
    status: 'ready',
    account: { accountId: ids.account, username: 'demo.admin', displayName: 'Demo Admin', isOperator: false },
    context: contextSchema.parse(contextRow(revision, role, capabilities)),
  });
}

/** Render with a fresh memory-only query client and a router at `path` (pattern `route`). */
export function renderPage(
  ui: ReactElement,
  { path = '/', route = '*' }: { path?: string; route?: string } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={ui} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
