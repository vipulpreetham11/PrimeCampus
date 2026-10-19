import ExcelJS from 'exceljs';
import { expect, type Page } from '@playwright/test';
import { modal } from './ui';

// Import wizard helpers (same steps as tests/e2e/m1b.spec.ts), shared by the M2X specs.

export interface Upload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const csv = (name: string, lines: string[], encoding: BufferEncoding = 'utf8'): Upload => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(lines.join('\r\n') + '\r\n', encoding),
});

export async function xlsx(
  name: string,
  sheets: { name: string; rows: unknown[][]; hidden?: boolean }[],
): Promise<Upload> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, s.hidden ? { state: 'hidden' } : undefined);
    for (const r of s.rows) ws.addRow(r);
  }
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}

export const DATASET_RADIO = {
  classes: /^Classes & sections/,
  staff: /^Staff/,
  students: /^Students & parents/,
  placements: /^Placements/,
} as const;

/** Wizard: choose the dataset, upload the file, check the mapping. Stops before uploading rows. */
export async function chooseFile(page: Page, dataset: keyof typeof DATASET_RADIO, file: Upload) {
  await page.goto('/imports/new');
  await page.getByRole('radio', { name: DATASET_RADIO[dataset] }).check();
  await page.getByLabel('Spreadsheet file (.xlsx or .csv)').setInputFiles(file);
}

/** Wizard steps 1–5; returns the job id once every row is uploaded and checked. */
export async function startImport(page: Page, dataset: keyof typeof DATASET_RADIO, file: Upload) {
  await chooseFile(page, dataset, file);
  await expect(page.getByText('All required columns are matched.')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Upload rows for checking' }).click();
  await expect(page.getByText(/rows are uploaded and checked/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole('link', { name: 'Review rows' }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('tile-Ready')).toBeVisible({ timeout: 30_000 });
  return page.url().split('/').pop()!;
}

export async function tile(page: Page, label: string): Promise<number> {
  const text = (await page.getByTestId(`tile-${label}`).textContent()) ?? '';
  return Number(/(\d[\d,]*)/.exec(text.replace(label, ''))![1]!.replace(/,/g, ''));
}

export async function expectTiles(page: Page, want: Record<string, number>) {
  for (const [label, n] of Object.entries(want)) {
    await expect.poll(() => tile(page, label), { message: `tile ${label}`, timeout: 30_000 }).toBe(n);
  }
}

/** Import button → wait for the run summary. */
export async function runImport(
  page: Page,
  button: RegExp = /^(Import \d+ rows?|Confirm \d+ existing rows?)$/,
) {
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByText(/^This run: /)).toBeVisible({ timeout: 180_000 });
  return (await page.getByText(/^This run: /).textContent()) ?? '';
}

export const importRow = (page: Page, n: number) => page.getByTestId(`import-row-${n}`);

export async function closeImport(page: Page) {
  await page.getByRole('button', { name: 'Close import' }).click();
  await modal(page).getByRole('button', { name: 'Close import' }).click();
  await expect(page.getByText(/This import is closed and read-only/)).toBeVisible({ timeout: 30_000 });
}

export const STUDENT_HEADER = [
  'Admission no',
  'Student name',
  'Gender',
  'Date of birth',
  'Class',
  'Section',
  'Parent 1 name',
  'Parent 1 mobile',
];
