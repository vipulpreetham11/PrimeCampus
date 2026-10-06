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
