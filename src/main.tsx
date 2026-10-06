import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { initSession } from '@/lib/session/session';
import '@/index.css';

void initSession();

if (import.meta.env.VITE_E2E_HOOKS === '1') {
  // Playwright-only test hooks; this branch is removed from production builds.
  void import('@/app/e2e-hooks').then((m) => m.installE2EHooks());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
