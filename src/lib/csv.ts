// Client-side CSV (M3 day book/dues, M4 salary and reports): built from RPC rows only, amounts as
// rupees with 2 decimals ("4500.50"), never floats. Text cells that a spreadsheet would run as a
// formula (=, +, -, @) are prefixed with an apostrophe.

export type CsvCell = string | number | null;

function cell(v: CsvCell, isAmount = false): string {
  if (v === null) return '';
  let s = String(v);
  if (!isAmount && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (CRLF line ends, as spreadsheets expect). `amountCols` are left unescaped numbers. */
export function toCsv(
  headers: string[],
  rows: CsvCell[][],
  amountCols: ReadonlySet<number> = new Set(),
): string {
  const lines = [headers.map((h) => cell(h)).join(',')];
  for (const r of rows) lines.push(r.map((v, i) => cell(v, amountCols.has(i))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Save CSV text as a file (no server round trip, nothing stored). */
export function downloadCsv(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
