// Fails if the production build contains secret material or test-only hooks (TRD §20).
// Note: a literal `grep sb_secret dist` always matches supabase-js's own key-format check
// (`e.startsWith("sb_secret_")`), so this looks for actual key VALUES instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);

const checks = [
  ['secret API key value', /sb_secret_[A-Za-z0-9_-]{10,}/],
  [
    'legacy service_role JWT',
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/,
  ],
  ['service role mention', /service_role/],
  ['e2e test hooks', /__pcE2E/],
  ['source maps', /sourceMappingURL=/],
  ['private env file content', /SUPABASE_ACCESS_TOKEN|E2E_OPERATOR_PASSWORD/],
];

let failed = false;
for (const file of files) {
  if (file.endsWith('.map')) {
    console.error(`FAIL source map shipped: ${path.relative(dist, file)}`);
    failed = true;
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const [label, re] of checks) {
    if (re.test(text)) {
      console.error(`FAIL ${label}: ${path.relative(dist, file)}`);
      failed = true;
    }
  }
}
const prefixOnly = files.some((f) => readFileSync(f, 'utf8').includes('sb_secret'));
console.log(`${files.length} files scanned in ${path.relative(process.cwd(), dist) || dist}.`);
if (prefixOnly)
  console.log('note: "sb_secret" appears only as supabase-js key-prefix detection code (no key value).');
if (failed) process.exit(1);
console.log('OK: no secret key values, service-role tokens, test hooks or source maps.');
