import * as ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeCsv, parseCsv, type PapaModule } from '@/features/imports/parse/csv';
import { dateToIsoUtc, excelValueToText, numberToText } from '@/features/imports/parse/cells';
import { PARSE_LIMITS, precheckFile, type ParseResult } from '@/features/imports/parse/sheet';
import { parseXlsx, type ExcelJsModule } from '@/features/imports/parse/xlsx';

// Brief M1b "done when": XLSX + CSV parsing (Excel date cell → YYYY-MM-DD at IST and UTC test
// time zones, long numbers, blank rows, header detection).

const excel = ExcelJS as unknown as ExcelJsModule;
const papa = Papa as unknown as PapaModule;

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});
const ZONES = ['Asia/Kolkata', 'UTC', 'America/Los_Angeles'];

function sheetOf(r: ParseResult) {
  if (!r.ok) throw new Error(`expected a sheet, got: ${r.message}`);
  return r.sheet;
}

async function xlsxBytes(build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('First'), wb);
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

const csvBytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('cell text', () => {
  it('numbers keep every digit, no exponent and no ".0"', () => {
    expect(numberToText(9876543210)).toBe('9876543210');
    expect(numberToText(40)).toBe('40');
    expect(numberToText(12.5)).toBe('12.5');
    expect(numberToText(0.1 + 0.2)).toBe('0.3');
    expect(numberToText(1e21)).toBe('1000000000000000000000');
    expect(numberToText(123456789012345)).toBe('123456789012345');
    expect(numberToText(0.0000001)).toBe('0.0000001');
  });

  it.each(ZONES)('an Excel date (UTC midnight) is the same calendar day in %s', (tz) => {
    process.env.TZ = tz;
    expect(dateToIsoUtc(new Date(Date.UTC(2016, 3, 12)))).toBe('2016-04-12');
    expect(dateToIsoUtc(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
    expect(dateToIsoUtc(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });

  it('the time zone switch is real: local getters would give the wrong day west of UTC', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(new Date(Date.UTC(2016, 3, 12)).getDate()).toBe(11);
    process.env.TZ = 'Asia/Kolkata';
    expect(new Date(Date.UTC(2016, 3, 12)).getHours()).toBe(5); // 05:30 IST
  });

  it('formulas use the saved result; without one the cell is flagged', () => {
    expect(excelValueToText({ formula: 'A1*2', result: 42 })).toEqual({ kind: 'text', text: '42' });
    expect(excelValueToText({ sharedFormula: 'A1', result: 'x' })).toEqual({ kind: 'text', text: 'x' });
    expect(excelValueToText({ formula: 'A1*2' })).toEqual({ kind: 'unsaved-formula' });
    expect(excelValueToText({ richText: [{ text: 'Ravi ' }, { text: 'Kumar' }] })).toEqual({
      kind: 'text',
      text: 'Ravi Kumar',
    });
    expect(excelValueToText({ text: 'mail', hyperlink: 'mailto:a@b.c' })).toEqual({
      kind: 'text',
      text: 'mail',
    });
    expect(excelValueToText(true)).toEqual({ kind: 'text', text: 'TRUE' });
  });
});

describe('XLSX parsing', () => {
  it.each(ZONES)(
    'reads the first sheet: header detection, blank rows, dates, long numbers (TZ %s)',
    async (tz) => {
      process.env.TZ = tz;
      const bytes = await xlsxBytes((ws, wb) => {
        ws.addRow([]); // row 1 blank → header is row 2
        ws.addRow(['Admission no', ' Date of birth ', 'Mobile', 'Joined', '', 'Notes']);
        ws.addRow(['2024/001', new Date(Date.UTC(2016, 3, 12)), 9876543210, '12/06/2026', 'x', '  padded  ']);
        ws.addRow([]); // row 4 fully blank → skipped
        ws.addRow([
          '2024/002',
          '12-04-2016',
          '+91 98765 43210',
          { formula: 'TODAY()', result: new Date(Date.UTC(2026, 5, 1)) },
        ]);
        // a numeric serial shown with a date format is a date cell too
        const r = ws.addRow(['2024/003', 42472]);
        r.getCell(2).numFmt = 'dd/mm/yyyy';
        wb.addWorksheet('Second').addRow(['ignored']);
      });
      const sheet = sheetOf(await parseXlsx(bytes, excel));
      expect(sheet.headerRowNo).toBe(2);
      expect(sheet.headers).toEqual([
        'Admission no',
        'Date of birth',
        'Mobile',
        'Joined',
        'Column E',
        'Notes',
      ]);
      expect(sheet.rows.map((r) => r.rowNo)).toEqual([3, 5, 6]);
      expect(sheet.rows[0]!.cells).toEqual([
        '2024/001',
        '2016-04-12',
        '9876543210',
        '12/06/2026',
        'x',
        'padded',
      ]);
      expect(sheet.rows[1]!.cells).toEqual([
        '2024/002',
        '12-04-2016',
        '+91 98765 43210',
        '2026-06-01',
        '',
        '',
      ]);
      expect(sheet.rows[2]!.cells[1]).toBe('2016-04-12'); // serial 42472
    },
  );

  it('refuses a file with formula cells that have no saved value, naming the cells', async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(['Name', 'Total']);
      ws.addRow(['A', { formula: 'B1*2' }]);
      ws.addRow(['B', { formula: 'B2*2' }]);
    });
    const r = await parseXlsx(bytes, excel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no saved value \(B2, B3\)/);
  });

  it('merged cells keep the value only in the top-left cell', async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(['Class', 'Section']);
      ws.addRow(['Class 1', 'A']);
      ws.addRow(['', 'B']);
      ws.mergeCells('A2:A3');
    });
    const sheet = sheetOf(await parseXlsx(bytes, excel));
    expect(sheet.rows.map((r) => r.cells)).toEqual([
      ['Class 1', 'A'],
      ['', 'B'],
    ]);
  });

  it('refuses bytes that are not a workbook, and an empty workbook', async () => {
    const bad = await parseXlsx(csvBytes('not,a,workbook'), excel);
    expect(bad.ok).toBe(false);
    const empty = await parseXlsx(await xlsxBytes(() => undefined), excel);
    expect(empty).toEqual({ ok: false, message: expect.stringMatching(/empty/) });
  });
});

describe('CSV parsing', () => {
  it('BOM, header after blank lines, quoted commas/newlines, blank rows skipped, row numbers kept', () => {
    const text = decodeCsv(
      csvBytes('﻿\n\nName,Mobile,Note\n"Rao, Meera",9876543210,"two\nlines"\n,,\n  Ravi  ,09876543210,x\n'),
    );
    const sheet = sheetOf(parseCsv(text, papa));
    expect(sheet.headerRowNo).toBe(3);
    expect(sheet.headers).toEqual(['Name', 'Mobile', 'Note']);
    expect(sheet.rows).toEqual([
      { rowNo: 4, cells: ['Rao, Meera', '9876543210', 'two\nlines'] },
      { rowNo: 6, cells: ['Ravi', '09876543210', 'x'] },
    ]);
  });

  it('falls back to Windows-1252 when the bytes are not UTF-8 (Excel "CSV" on Windows)', () => {
    const bytes = new Uint8Array([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]); // "Name\nJosé" in cp1252
    expect(decodeCsv(bytes.buffer)).toBe('Name\nJosé');
  });

  it('refuses an unclosed quote with its row number', () => {
    const r = parseCsv('Name,Mobile\nOk,1\n"Broken,2\n', papa);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Row 3 has a quote/);
  });

  it('header only, or nothing at all, is refused with a plain message', () => {
    expect(parseCsv('Name,Mobile\n\n', papa)).toEqual({
      ok: false,
      message: expect.stringMatching(/no data rows/),
    });
    expect(parseCsv('\n,,\n', papa)).toEqual({ ok: false, message: expect.stringMatching(/empty/) });
  });
});

describe('limits', () => {
  const rows = (n: number) => ['Name', ...Array.from({ length: n }, (_, i) => `P${i}`)].join('\n');

  it(`accepts ${PARSE_LIMITS.maxDataRows} data rows and refuses one more`, () => {
    expect(sheetOf(parseCsv(rows(PARSE_LIMITS.maxDataRows), papa)).rows).toHaveLength(
      PARSE_LIMITS.maxDataRows,
    );
    const over = parseCsv(rows(PARSE_LIMITS.maxDataRows + 1), papa);
    expect(over).toEqual({ ok: false, message: expect.stringMatching(/more than 10,000 data rows/) });
  });

  it('refuses files over 5 MB and other file types before reading them', () => {
    expect(precheckFile('a.csv', 5 * 1024 * 1024)).toBeNull();
    expect(precheckFile('a.csv', 5 * 1024 * 1024 + 1)).toMatch(/larger than 5 MB/);
    expect(precheckFile('a.XLSX', 100)).toBeNull();
    expect(precheckFile('old.xls', 100)).toMatch(/\.xlsx/);
    expect(precheckFile('a.csv', 0)).toMatch(/empty/);
  });
});
