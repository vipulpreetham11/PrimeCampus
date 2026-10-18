import type * as PapaTypes from 'papaparse';
import { sheetFromGrid, type ParseResult } from './sheet';

export type PapaModule = typeof PapaTypes;

/**
 * CSV bytes → text. UTF-8 first (with or without BOM); Excel's plain "CSV" on Windows is
 * Windows-1252, so fall back to that when the bytes are not valid UTF-8.
 */
export function decodeCsv(buffer: ArrayBuffer): string {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    s = new TextDecoder('windows-1252').decode(buffer);
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Every value stays text (no type guessing). `rowNo` is the record number, which is the row
 * number a spreadsheet program shows when it opens the file.
 */
export function parseCsv(textContent: string, Papa: PapaModule): ParseResult {
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
  return sheetFromGrid(
    result.data.map((cells, i) => ({ rowNo: i + 1, cells: cells.map((c) => String(c ?? '')) })),
  );
}
