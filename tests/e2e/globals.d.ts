// window.__pcE2E is installed by src/app/e2e-hooks.ts in the Playwright build only.
export {};
declare global {
  interface Window {
    __pcE2E?: {
      revision: () => number | null;
      forceStaleRevision: () => void;
      probeSchoolRpc: () => Promise<string>;
    };
  }
}
