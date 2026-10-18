/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // TRD §19 budget is ≤300 KB *compressed* initial JS (enforced by `npm run check:bundle`); Vite's
  // warning measures raw size. The lazy exceljs chunk (imports only) is ~930 KB raw.
  build: { sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 1000 },
  // The import parser worker lazy-loads exceljs/papaparse, which needs an ES module worker.
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    env: {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      VITE_LOGIN_EMAIL_DOMAIN: 'login.example.test',
    },
  },
});
