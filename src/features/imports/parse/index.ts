import { decodeCsv, parseCsv, type PapaModule } from './csv';
import { fileKind, type ParseResult } from './sheet';
import { parseXlsx, type ExcelJsModule } from './xlsx';

export interface ParserLibs {
  excel: () => Promise<ExcelJsModule>;
  papa: () => Promise<PapaModule>;
}

/** Parse an uploaded file by extension (size/type already checked by `precheckFile`). */
export async function parseSpreadsheet(
  name: string,
  buffer: ArrayBuffer,
  libs: ParserLibs,
): Promise<ParseResult> {
  const kind = fileKind(name);
  if (kind === 'xlsx') return parseXlsx(buffer, await libs.excel());
  if (kind === 'csv') return parseCsv(decodeCsv(buffer), await libs.papa());
  return { ok: false, message: 'Choose an Excel workbook (.xlsx) or a CSV file (.csv).' };
}
