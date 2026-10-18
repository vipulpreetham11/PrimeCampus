// Fails if the production build contains secret material or test-only hooks (TRD §20), if the
// initial JS is over the TRD §19 budget (300 KB gzip), or if the spreadsheet libraries (exceljs,
// papaparse) are part of the initial load instead of lazy chunks (brief M1b).
// Note: a literal `grep sb_secret dist` always matches supabase-js's own key-format check
// (`e.startsWith("sb_secret_")`), so this looks for actual key VALUES instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

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

// ---- initial bundle budget + lazy spreadsheet libraries
const BUDGET = 300 * 1024;
const LAZY_LIBS = [
  ['exceljs', /xl\/sharedStrings\.xml/],
  ['papaparse', /BAD_DELIMITERS/],
];
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const initial = new Set();
const queue = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map(
  (m) => m[1],
);
// Follow static imports too (dynamic import() chunks are lazy and not counted).
while (queue.length > 0) {
  const rel = queue.shift();
  if (initial.has(rel)) continue;
  initial.add(rel);
  const code = readFileSync(path.join(dist, rel), 'utf8');
  for (const m of code.matchAll(/(?:^|[;}\s])import\s*(?:[\w*{}\s,$]+from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    queue.push(path.posix.join(path.posix.dirname(rel), m[1]));
  }
}
let total = 0;
for (const rel of initial) {
  const code = readFileSync(path.join(dist, rel));
  total += gzipSync(code).length;
  for (const [lib, marker] of LAZY_LIBS) {
    if (marker.test(code.toString('utf8'))) {
      console.error(`FAIL ${lib} is in the initial bundle: ${rel}`);
      failed = true;
    }
  }
}
for (const [lib, marker] of LAZY_LIBS) {
  const lazy = files.filter((f) => f.endsWith('.js') && marker.test(readFileSync(f, 'utf8')));
  const names = lazy.map((f) => path.relative(dist, f)).filter((rel) => !initial.has(rel));
  if (names.length === 0) {
    console.error(`FAIL no separate lazy chunk contains ${lib}`);
    failed = true;
  } else {
    console.log(`lazy ${lib} chunk(s): ${names.join(', ')}`);
  }
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`initial JS: ${initial.size} files, ${kb(total)} gzip (budget ${kb(BUDGET)})`);
if (total > BUDGET) {
  console.error('FAIL initial JS is over the budget');
  failed = true;
}
if (failed) process.exit(1);
console.log('OK: initial bundle within budget; spreadsheet libraries load lazily.');
