import type * as ExcelJsTypes from 'exceljs';
import { excelValueToText } from './cells';
import { sheetFromGrid, type GridRow, type ParseResult } from './sheet';

export type ExcelJsModule = typeof ExcelJsTypes;

/**
 * Read the first VISIBLE worksheet of an .xlsx file into text rows (hidden and "very hidden" sheets
 * are skipped). Macros, external links and embedded objects are never run (ExcelJS only reads cell
 * data). Formulas use their saved result (see excelValueToText).
 */
export async function parseXlsx(buffer: ArrayBuffer, ExcelJS: ExcelJsModule): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return {
      ok: false,
      message: 'This file could not be read as an Excel workbook. Save it as .xlsx (or CSV) and try again.',
    };
  }
  const sheet = workbook.worksheets.find((w) => (w.state ?? 'visible') === 'visible');
  if (!sheet) return { ok: false, message: 'This workbook has no visible sheets.' };

  const grid: GridRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      // A merged range keeps its value in the top-left cell only.
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
        cells[colNo - 1] = '';
        return;
      }
      cells[colNo - 1] = excelValueToText(cell.value);
    });
    for (let i = 0; i < cells.length; i += 1) cells[i] ??= '';
    grid.push({ rowNo, cells });
  });

  return sheetFromGrid(grid);
}
