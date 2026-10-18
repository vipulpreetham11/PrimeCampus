import type * as PapaTypes from 'papaparse';
import { sheetFromGrid, type ParseResult } from './sheet';

export type PapaModule = typeof PapaTypes;

/** True when the bytes contain at least one well-formed multi-byte UTF-8 sequence. */
export function hasValidMultibyteUtf8(bytes: Uint8Array): boolean {
  const cont = (b: number | undefined) => b !== undefined && b >= 0x80 && b <= 0xbf;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (b < 0xc2 || b > 0xf4) continue;
    const b1 = bytes[i + 1];
    if (b <= 0xdf) {
      if (cont(b1)) return true;
    } else if (b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80;
      const hi = b === 0xed ? 0x9f : 0xbf;
      if (b1 !== undefined && b1 >= lo && b1 <= hi && cont(bytes[i + 2])) return true;
    } else {
      const lo = b === 0xf0 ? 0x90 : 0x80;
      const hi = b === 0xf4 ? 0x8f : 0xbf;
      if (b1 !== undefined && b1 >= lo && b1 <= hi && cont(bytes[i + 2]) && cont(bytes[i + 3])) return true;
    }
  }
  return false;
}

export interface DecodedCsv {
  text: string;
  /** Some bytes were not valid UTF-8 and became U+FFFD (the rows are named in a warning). */
  lossy: boolean;
}

/**
 * CSV bytes → text.
 *  - Valid UTF-8 (with or without BOM): decoded as is.
 *  - Invalid UTF-8 but with real multi-byte UTF-8 in it (e.g. Telugu names plus one stray byte):
 *    still UTF-8, with U+FFFD only where a byte is bad — never re-decode the whole file because of
 *    one byte.
 *  - No multi-byte UTF-8 at all: Windows-1252 (Excel's plain "CSV" on Windows).
 */
export function decodeCsv(buffer: ArrayBuffer): DecodedCsv {
  const bytes = new Uint8Array(buffer);
  let text: string;
  let lossy = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (hasValidMultibyteUtf8(bytes)) {
      text = new TextDecoder('utf-8').decode(bytes);
      lossy = true;
    } else {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
  }
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, lossy };
}

function rowList(rows: number[]): string {
  const shown = rows.slice(0, 10).join(', ');
  return rows.length > 10 ? `${shown} and ${rows.length - 10} more` : shown;
}

/**
 * Every value stays text (no type guessing). `rowNo` is the record number, which is the row
 * number a spreadsheet program shows when it opens the file.
 */
export function parseCsv(textContent: string, Papa: PapaModule, lossy = false): ParseResult {
  const result = Papa.parse<string[]>(textContent, {
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
  });
  const quoteError = result.errors.find((e) => e.type === 'Quotes');
  if (quoteError) {
    const row = (quoteError.row ?? 0) + 1;
    return {
      ok: false,
      message: `Row ${row} has a quote (") that is never closed. Fix the file and upload it again.`,
    };
  }
  const parsed = sheetFromGrid(
    result.data.map((cells, i) => ({ rowNo: i + 1, cells: cells.map((c) => String(c ?? '')) })),
  );
  if (!parsed.ok || !lossy) return parsed;
  const bad = [
    ...(parsed.sheet.headers.some((h) => h.includes('\uFFFD')) ? [parsed.sheet.headerRowNo] : []),
    ...parsed.sheet.rows.filter((r) => r.cells.some((c) => c.includes('\uFFFD'))).map((r) => r.rowNo),
  ];
  if (bad.length === 0) return parsed;
  const warning =
    `Some characters could not be read and show as � in row${bad.length === 1 ? '' : 's'} ${rowList(bad)}. ` +
    'Check those rows after uploading, or save the file as "CSV UTF-8" and upload it again.';
  return { ok: true, sheet: { ...parsed.sheet, warnings: [...parsed.sheet.warnings, warning] } };
}
