import type * as ExcelJsTypes from 'exceljs';
import { excelValueToText } from './cells';
import { sheetFromGrid, type GridRow, type ParseResult } from './sheet';

export type ExcelJsModule = typeof ExcelJsTypes;

/**
 * Read the FIRST worksheet of an .xlsx file into text rows. Macros, external links and embedded
 * objects are never run (ExcelJS only reads cell data). Formulas use the saved result; a formula
 * cell without one refuses the file with the cell addresses (TRD §14.2).
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
  const sheet = workbook.worksheets[0];
  if (!sheet) return { ok: false, message: 'This workbook has no sheets.' };

  const grid: GridRow[] = [];
  const unsaved: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      // A merged range keeps its value in the top-left cell only.
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
        cells[colNo - 1] = '';
        return;
      }
      const t = excelValueToText(cell.value);
      if (t.kind === 'unsaved-formula') {
        unsaved.push(cell.address);
        cells[colNo - 1] = '';
      } else {
        cells[colNo - 1] = t.text;
      }
    });
    for (let i = 0; i < cells.length; i += 1) cells[i] ??= '';
    grid.push({ rowNo, cells });
  });

  if (unsaved.length > 0) {
    const shown = unsaved.slice(0, 5).join(', ');
    const more = unsaved.length > 5 ? ` and ${unsaved.length - 5} more` : '';
    return {
      ok: false,
      message:
        `Some formula cells have no saved value (${shown}${more}). ` +
        'Open the file in Excel, let it calculate, save it, and upload it again — or replace the formulas with values.',
    };
  }
  return sheetFromGrid(grid);
}
