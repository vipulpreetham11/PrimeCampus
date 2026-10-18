import type { PapaModule } from './csv';
import type { ParserLibs } from './index';
import type { ExcelJsModule } from './xlsx';

// exceljs and papaparse are CommonJS/UMD packages: depending on the bundler the module object
// is either the namespace itself or sits on `default`. Both are lazy-loaded here only (brief rules).
function interop<T>(m: unknown): T {
  const d = (m as { default?: unknown }).default;
  return (d && (typeof d === 'object' || typeof d === 'function') ? d : m) as T;
}

export const loadExcelJs = (): Promise<ExcelJsModule> =>
  import('exceljs').then((m) => interop<ExcelJsModule>(m));

export const loadPapa = (): Promise<PapaModule> => import('papaparse').then((m) => interop<PapaModule>(m));

export const lazyLibs: ParserLibs = { excel: loadExcelJs, papa: loadPapa };
