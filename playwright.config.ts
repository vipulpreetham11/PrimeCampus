import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// E2E runs against the LIVE Supabase project, inside the Demo School only (CLAUDE.md test data safety).
// Credentials come from env vars (E2E_OPERATOR_USERNAME / E2E_OPERATOR_PASSWORD) and are never committed.

// Public VITE_ values: use the shell's, else .env.example (they are public build config, not secrets).
const publicEnv: Record<string, string> = {};
for (const line of readFileSync(new URL('./.env.example', import.meta.url), 'utf8').split('\n')) {
  const m = /^(VITE_[A-Z_]+)=(.+)$/.exec(line.trim());
  if (m) publicEnv[m[1]!] = process.env[m[1]!] ?? m[2]!;
}

const port = 4173;
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1, // shared live accounts: run serially
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Container egress goes through an HTTPS proxy; localhost stays direct.
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Separate output dir: the e2e build enables window.__pcE2E; the production `dist` never does.
        command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${port} --strictPort`,
        port,
        reuseExistingServer: false,
        timeout: 180_000,
        env: { ...publicEnv, VITE_E2E_HOOKS: '1' },
      },
});
