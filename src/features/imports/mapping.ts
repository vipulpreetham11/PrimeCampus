import type { TemplateColumn } from '@/contracts/imports';
import type { ParsedSheet } from './parse/sheet';

// Column mapping (brief §2.4). Template columns come only from get_import_template — no column
// list is hard-coded here. A mapping is: file column index → canonical key (or null = ignored).

export type Mapping = (string | null)[];

/** Case-, space- and underscore-insensitive form used to compare headers with labels/keys. */
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '');
}

/**
 * Auto-match each file header to a template column by label or key. A template column is used at
 * most once: a repeated header stays unmapped.
 */
export function autoMap(headers: string[], columns: TemplateColumn[]): Mapping {
  const byName = new Map<string, string>();
  for (const c of columns) {
    byName.set(normalizeHeader(c.label), c.key);
    if (!byName.has(normalizeHeader(c.key))) byName.set(normalizeHeader(c.key), c.key);
  }
  const used = new Set<string>();
  return headers.map((h) => {
    const key = byName.get(normalizeHeader(h));
    if (!key || used.has(key)) return null;
    used.add(key);
    return key;
  });
}

/** Required template columns no file column is mapped to. */
export function missingRequired(mapping: Mapping, columns: TemplateColumn[]): TemplateColumn[] {
  const mapped = new Set(mapping.filter((k): k is string => k !== null));
  return columns.filter((c) => c.required && !mapped.has(c.key));
}

/** Template keys mapped from more than one file column. */
export function duplicateTargets(mapping: Mapping): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of mapping) {
    if (k === null) continue;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

export function mappingProblems(mapping: Mapping, columns: TemplateColumn[]): string[] {
  const problems: string[] = [];
  const missing = missingRequired(mapping, columns);
  if (missing.length > 0) {
    problems.push(`Choose a file column for: ${missing.map((c) => c.label).join(', ')}.`);
  }
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k;
  for (const k of duplicateTargets(mapping)) {
    problems.push(`"${label(k)}" is chosen for more than one file column. Keep only one.`);
  }
  return problems;
}

/** Up to `n` non-empty sample values of one file column (shown on the mapping step only). */
export function sampleValues(sheet: ParsedSheet, colIndex: number, n = 3): string[] {
  const out: string[] = [];
  for (const r of sheet.rows) {
    const v = r.cells[colIndex] ?? '';
    if (v !== '') out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

export interface StageRow {
  row_no: number;
  data: Record<string, string>;
}

/** Rows for stage_import_rows: canonical key → cell text, mapped columns only, blanks omitted. */
export function buildStageRows(sheet: ParsedSheet, mapping: Mapping): StageRow[] {
  return sheet.rows.map((r) => {
    const data: Record<string, string> = {};
    mapping.forEach((key, i) => {
      const v = r.cells[i] ?? '';
      if (key !== null && v !== '') data[key] = v;
    });
    return { row_no: r.rowNo, data };
  });
}

/** What start_import records as p_mapping: the file header → key pairs (no cell values). */
export function mappingRecord(headers: string[], mapping: Mapping) {
  return {
    columns: headers.map((header, i) => ({ header, key: mapping[i] ?? null })),
  };
}
