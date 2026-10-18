// Excel cell value → text (brief §2.3). The server parses dates, mobiles, gender, yes/no etc.;
// the browser only turns each cell into the text a person sees in the sheet.

/**
 * Numbers without exponent or ".0": a phone 9876543210 stays "9876543210". Excel keeps 15
 * significant digits, so float noise beyond that is dropped (0.1+0.2 → "0.3").
 */
export function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) {
    return Math.abs(n) < 1e21 ? n.toFixed(0) : BigInt(n).toString();
  }
  const clean = Number(n.toPrecision(15));
  const s = String(clean);
  if (!/e/i.test(s)) return s;
  // Very small/large non-integers: plain decimal notation, trailing zeros removed.
  return clean.toFixed(20).replace(/\.?0+$/, '');
}

/**
 * An Excel date cell → 'YYYY-MM-DD' from the UTC parts of the JS Date. ExcelJS builds dates
 * from the cell serial in UTC, so local time (and toISOString on a local date) would shift the
 * day in some time zones.
 */
export function dateToIsoUtc(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Convert one ExcelJS cell value (any of its CellValue shapes) to trimmed text.
 *
 * Formulas use the saved (cached) result — the app is not an Excel calculation engine (TRD §14.2).
 * A formula without a result becomes ''. ExcelJS 4.4 reports a formula whose saved result is an
 * empty string (=IF(B2="","",…), =IFERROR(…,"")) exactly like one that was never calculated, so the
 * two can't be told apart and neither refuses the file; a blank required value is flagged per row
 * by the server.
 */
export function excelValueToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return numberToText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return dateToIsoUtc(v);
  if (isObject(v)) {
    if ('formula' in v || 'sharedFormula' in v) return excelValueToText(v.result);
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((p: unknown) => (isObject(p) && typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();
    }
    if ('hyperlink' in v && 'text' in v) return excelValueToText(v.text);
    if ('error' in v && typeof v.error === 'string') return v.error; // '#N/A' etc.: server flags the row
    if ('text' in v && typeof v.text === 'string') return v.text.trim();
  }
  return '';
}
