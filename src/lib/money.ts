// Money is integer paise end to end (CLAUDE.md rule 6). Parsing uses string math only.

export type Paise = number;

export type ParseResult = { ok: true; paise: Paise } | { ok: false; error: string };

export interface ParseOptions {
  allowNegative?: boolean;
  allowZero?: boolean;
}

// Optional sign, optional ₹/Rs prefix, digits with optional comma grouping, optional 1–2 decimals.
const RUPEE_PATTERN = /^(-)?\s*(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/i;

/** Parse user-typed rupees ("1,00,000.50", "₹ 0.05", "-500") into integer paise without floats. */
export function parseRupeesToPaise(input: string, options: ParseOptions = {}): ParseResult {
  const { allowNegative = false, allowZero = true } = options;
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Enter an amount' };
  const match = RUPEE_PATTERN.exec(text);
  if (!match) return { ok: false, error: 'Enter an amount like 1500 or 1,500.50 (at most 2 decimal places)' };
  const [, sign, intPart = '', fraction = ''] = match;
  const digits = intPart.replace(/,/g, '');
  const paiseText = digits + fraction.padEnd(2, '0');
  const stripped = paiseText.replace(/^0+(?=\d)/, '');
  // Number.MAX_SAFE_INTEGER has 16 digits; keep well inside it.
  if (stripped.length > 15) return { ok: false, error: 'Amount is too large' };
  const magnitude = Number(stripped);
  if (magnitude === 0) {
    return allowZero ? { ok: true, paise: 0 } : { ok: false, error: 'Amount must be more than ₹0' };
  }
  if (sign) {
    if (!allowNegative) return { ok: false, error: 'Amount cannot be negative' };
    return { ok: true, paise: -magnitude };
  }
  return { ok: true, paise: magnitude };
}

function assertPaise(paise: Paise): void {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Paise must be a safe integer, got ${paise}`);
}

/** "123456" paise -> "1234.56" (plain, for editable inputs). */
export function paiseToRupeesString(paise: Paise): string {
  assertPaise(paise);
  const negative = paise < 0;
  const abs = String(Math.abs(paise)).padStart(3, '0');
  const rupees = abs.slice(0, -2);
  const fraction = abs.slice(-2);
  return `${negative ? '-' : ''}${rupees}.${fraction}`;
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/** Display only: 10000050 -> "₹1,00,000.50". Formats from the exact decimal string, not paise/100. */
export function formatINR(paise: Paise): string {
  assertPaise(paise);
  // Intl accepts a decimal string, so no float division is involved.
  return INR.format(paiseToRupeesString(paise) as unknown as number);
}

// ---------------------------------------------------------------------------------------------
// Fees (M3): one shared parser and formatter for every rupee field and amount on the fee screens.

/**
 * The fee screens' rupee parser: digits with Indian or western comma grouping, optional ₹ / Rs,
 * at most 2 decimals; never negative. Zero only where it means something (a ₹0 price-list cell).
 */
export function parseRupees(input: string, options: { allowZero?: boolean } = {}): ParseResult {
  return parseRupeesToPaise(input, { allowNegative: false, allowZero: options.allowZero ?? false });
}

/** Display: 10000050 → "₹1,00,000.50" (Indian grouping). */
export const formatPaise = formatINR;

/** CSV cell: rupees with exactly 2 decimals and no grouping ("4500.50"), from string math. */
export function paiseToCsvRupees(paise: Paise): string {
  return paiseToRupeesString(paise);
}

const PERCENT_PATTERN = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/;

/** "12.5" / "12.5%" → 1250 basis points (1% = 100). 0.01%–100%; string math only. */
export function parsePercentToBasisPoints(
  input: string,
): { ok: true; bp: number } | { ok: false; error: string } {
  const m = PERCENT_PATTERN.exec(input.trim());
  if (!m) return { ok: false, error: 'Enter a percentage like 10 or 12.5 (at most 2 decimal places)' };
  const bp = Number(m[1]! + (m[2] ?? '').padEnd(2, '0'));
  if (bp < 1 || bp > 10000) return { ok: false, error: 'Percent must be from 0.01% to 100%' };
  return { ok: true, bp };
}

/** 1250 → "12.5%", 1000 → "10%", 5 → "0.05%". */
export function formatBasisPoints(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.trunc(n / 10)]!;
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function belowThousand(n: number): string {
  const h = Math.trunc(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** Whole rupees in words with the Indian system: crore, lakh, thousand, hundred. */
function rupeesInWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.trunc(n / 10_000_000);
  const lakh = Math.trunc((n % 10_000_000) / 100_000);
  const thousand = Math.trunc((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${rupeesInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/**
 * Amount in words for receipts (Indian numbering): 455050 → "Rupees Four Thousand Five Hundred Fifty
 * and Fifty Paise Only"; 5 → "Rupees Zero and Five Paise Only".
 */
export function amountInWords(paise: Paise): string {
  assertPaise(paise);
  if (paise < 0) throw new RangeError('amountInWords: amount must not be negative');
  const rupees = Math.trunc(paise / 100);
  const p = paise % 100;
  const words = `Rupees ${rupeesInWords(rupees)}`;
  return p ? `${words} and ${belowHundred(p)} Paise Only` : `${words} Only`;
}
