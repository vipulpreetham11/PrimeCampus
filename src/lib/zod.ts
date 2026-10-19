import { z } from 'zod';

// Import `z` from here, never from 'zod' directly (ESLint enforces it): this module sets Zod's config
// before any schema is built. Our CSP (public/_headers) has no 'unsafe-eval'; without `jitless`, Zod 4
// probes `new Function` when it builds an object schema, the CSP blocks the probe (Zod falls back)
// and the browser reports a `script-src eval` violation on every page load (found in M2X). The
// compiled fast path could never be used under this CSP anyway.
z.config({ jitless: true });

export { z };
