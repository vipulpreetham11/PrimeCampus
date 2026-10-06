import { getSetupSnapshot } from '@/lib/rpc';
import { sessionStore } from '@/lib/session/store';

// Only bundled when VITE_E2E_HOOKS=1 (Playwright build). Lets a test force the client's context
// revision out of date and then fire one real school RPC through the normal RPC layer, so the
// STALE_CONTEXT handling can be verified end to end against the live backend.
declare global {
  interface Window {
    __pcE2E?: {
      revision: () => number | null;
      forceStaleRevision: () => void;
      probeSchoolRpc: () => Promise<string>;
    };
  }
}

export function installE2EHooks(): void {
  window.__pcE2E = {
    revision: () => sessionStore.get().context?.context_revision ?? null,
    forceStaleRevision: () => {
      const ctx = sessionStore.get().context;
      if (ctx) sessionStore.set({ context: { ...ctx, context_revision: ctx.context_revision - 1 } });
    },
    probeSchoolRpc: () =>
      getSetupSnapshot().then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? 'error',
      ),
  };
}
