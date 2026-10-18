// Spreadsheet → text grid (brief §2.3, TRD §14.2). Shared by the XLSX and CSV readers.
// Cell VALUES never leave this module except as the returned sheet: they are not logged, stored
// or sent to telemetry.

export const PARSE_LIMITS = {
  /** TRD §14.2: CSV/XLSX up to 5 MB. */
  maxBytes: 5 * 1024 * 1024,
  /** TRD §14.2: 10,000 source rows per file (data rows, after the header). */
  maxDataRows: 10_000,
  /** stage_import_rows accepts row_no 1–100000. */
  maxRowNo: 100_000,
} as const;

export interface ParsedRow {
  /** The spreadsheet row number (1-based), so users can find the row in their file. */
  rowNo: number;
  /** One text value per header column (trimmed; '' when blank). */
  cells: string[];
}

export interface ParsedSheet {
  /** Header texts; a blank header cell becomes "Column <letter>". */
  headers: string[];
  headerRowNo: number;
  rows: ParsedRow[];
}

export type ParseResult = { ok: true; sheet: ParsedSheet } | { ok: false; message: string };

/** A raw grid row: the spreadsheet row number and its cell texts by 0-based column. */
export interface GridRow {
  rowNo: number;
  cells: string[];
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const isBlank = (cells: string[]) => cells.every((c) => c.trim() === '');

/**
 * First non-empty row = header; later fully blank rows are skipped; row numbers are kept.
 * Enforces the row limits with a plain message.
 */
export function sheetFromGrid(grid: Iterable<GridRow>): ParseResult {
  let header: GridRow | null = null;
  const rows: ParsedRow[] = [];
  for (const raw of grid) {
    const cells = raw.cells.map((c) => c.trim());
    if (isBlank(cells)) continue;
    if (!header) {
      header = { rowNo: raw.rowNo, cells };
      continue;
    }
    if (raw.rowNo > PARSE_LIMITS.maxRowNo) {
      return {
        ok: false,
        message: `This file has data below row ${PARSE_LIMITS.maxRowNo.toLocaleString('en-IN')}. Remove empty rows or split the file.`,
      };
    }
    rows.push({ rowNo: raw.rowNo, cells });
    if (rows.length > PARSE_LIMITS.maxDataRows) {
      return {
        ok: false,
        message: `This file has more than ${PARSE_LIMITS.maxDataRows.toLocaleString('en-IN')} data rows. Split it into smaller files.`,
      };
    }
  }
  if (!header) return { ok: false, message: 'This file is empty. Add a header row and your data.' };
  // Trailing blank header cells are not columns.
  let width = header.cells.length;
  while (width > 0 && header.cells[width - 1] === '') width -= 1;
  const headers = header.cells.slice(0, width).map((h, i) => h || `Column ${columnLetter(i)}`);
  if (rows.length === 0) {
    return { ok: false, message: 'This file has a header row but no data rows.' };
  }
  return {
    ok: true,
    sheet: {
      headers,
      headerRowNo: header.rowNo,
      rows: rows.map((r) => ({
        rowNo: r.rowNo,
        cells: headers.map((_, i) => r.cells[i] ?? ''),
      })),
    },
  };
}

export type FileKind = 'xlsx' | 'csv';

export function fileKind(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/** Checks that need no parsing: file type and size. Returns a plain message, or null when fine. */
export function precheckFile(name: string, size: number): string | null {
  if (!fileKind(name)) {
    return 'Choose an Excel workbook (.xlsx) or a CSV file (.csv). Older .xls files: save them as .xlsx first.';
  }
  if (size === 0) return 'This file is empty.';
  if (size > PARSE_LIMITS.maxBytes) {
    return 'This file is larger than 5 MB. Remove extra sheets or columns, or split it into smaller files.';
  }
  return null;
}
