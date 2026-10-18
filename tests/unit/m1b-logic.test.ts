import * as ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { CommitChunkResult, ImportJob, ImportTemplate, StageResult } from '@/contracts/imports';
import { importTemplateSchema } from '@/contracts/imports';
import { batchRows, STAGE_MAX_ROWS } from '@/features/imports/batching';
import {
  autoMap,
  buildStageRows,
  mappingProblems,
  missingRequired,
  normalizeHeader,
  sampleValues,
  type StageRow,
} from '@/features/imports/mapping';
import { parseXlsx, type ExcelJsModule } from '@/features/imports/parse/xlsx';
import type { ParsedSheet } from '@/features/imports/parse/sheet';
import { runCommitLoop, runStaging } from '@/features/imports/runners';
import { buildTemplateCsv, buildTemplateXlsx, DATA_SHEET, HELP_SHEET } from '@/features/imports/template';
import { AppError } from '@/lib/errors';

// Brief M1b "done when": header auto-mapping, required-column check, batching into ≤500 rows,
// commit loop stops on uncertain error and resumes, template generation from a template response.

/** A real get_import_template('staff') response (migration 2000, private.imp_columns). */
const STAFF_TEMPLATE: ImportTemplate = importTemplateSchema.parse({
  dataset: 'staff',
  columns: [
    { key: 'employee_no', label: 'Employee no', required: true, example: 'T001', max: 40 },
    { key: 'full_name', label: 'Full name', required: true, example: 'Ravi Kumar', max: 200 },
    {
      key: 'gender',
      label: 'Gender',
      required: false,
      example: 'male',
      allowed: ['male', 'female', 'transgender'],
    },
    { key: 'phone', label: 'Mobile', required: false, example: '9876543210', hint: '10 digits' },
    { key: 'email', label: 'Email', required: false, example: 'ravi@example.com' },
    {
      key: 'staff_group',
      label: 'Staff group',
      required: true,
      example: 'Teaching staff',
      hint: 'Must already exist in Setup → Staff groups',
    },
    { key: 'designation', label: 'Designation', required: false, example: 'PGT Maths', max: 80 },
    { key: 'is_teaching', label: 'Teaching staff?', required: false, example: 'yes', allowed: ['yes', 'no'] },
    {
      key: 'joined_on',
      label: 'Joined on',
      required: true,
      example: '2024-06-01',
      hint: 'YYYY-MM-DD or DD/MM/YYYY',
    },
  ],
  needs_year: false,
  max_rows: 10000,
  max_rows_per_upload: 500,
  max_rows_per_commit: 100,
});
const COLS = STAFF_TEMPLATE.columns;

describe('header auto-mapping', () => {
  it('matches labels or keys ignoring case, spaces and underscores', () => {
    expect(normalizeHeader('  Employee   No ')).toBe('employeeno');
    const m = autoMap(
      ['EMPLOYEE NO', 'full_name', ' Staff  group ', 'joined on', 'Mobile', 'Something else'],
      COLS,
    );
    expect(m).toEqual(['employee_no', 'full_name', 'staff_group', 'joined_on', 'phone', null]);
  });

  it('students & parents: a bare "Mobile" / "Phone" / "Contact" header is the parent\'s mobile', () => {
    // private.imp_columns('students_guardians'), the two phone columns
    const cols = [
      { key: 'admission_no', label: 'Admission no', required: true },
      { key: 'mobile', label: 'Student mobile', required: false },
      { key: 'guardian1_phone', label: 'Parent 1 mobile', required: true },
    ];
    for (const h of ['Mobile', 'PHONE', ' contact ']) {
      expect(autoMap(['Admission no', h], cols, 'students_guardians')).toEqual([
        'admission_no',
        'guardian1_phone',
      ]);
    }
    // explicit headers still go where they say
    expect(autoMap(['Student mobile', 'Parent 1 mobile'], cols, 'students_guardians')).toEqual([
      'mobile',
      'guardian1_phone',
    ]);
    // other datasets are unchanged: staff "Mobile" is the staff phone
    expect(autoMap(['Mobile'], COLS, 'staff')).toEqual(['phone']);
  });

  it('a repeated header is matched once; the second copy is left unmapped', () => {
    expect(autoMap(['Full name', 'Full Name', 'Employee no'], COLS)).toEqual([
      'full_name',
      null,
      'employee_no',
    ]);
  });
});

describe('required-column check', () => {
  it('lists every required template column without a file column', () => {
    const m = autoMap(['Employee no', 'Mobile'], COLS);
    expect(missingRequired(m, COLS).map((c) => c.key)).toEqual(['full_name', 'staff_group', 'joined_on']);
    expect(mappingProblems(m, COLS)).toEqual([
      'Choose a file column for: Full name, Staff group, Joined on.',
    ]);
  });

  it('passes when all required columns are mapped, and flags a key chosen twice', () => {
    const ok = autoMap(['Employee no', 'Full name', 'Staff group', 'Joined on'], COLS);
    expect(mappingProblems(ok, COLS)).toEqual([]);
    expect(mappingProblems([...ok, 'full_name'], COLS)).toEqual([
      '"Full name" is chosen for more than one file column. Keep only one.',
    ]);
  });
});

describe('stage rows', () => {
  const sheet: ParsedSheet = {
    headers: ['Employee no', 'Ignored', 'Mobile'],
    headerRowNo: 1,
    warnings: [],
    rows: [
      { rowNo: 2, cells: ['T1', 'x', ''] },
      { rowNo: 4, cells: ['', '', '98'] },
      { rowNo: 5, cells: ['T3', 'y', '99'] },
      { rowNo: 7, cells: ['', 'only in an unmapped column', ''] },
    ],
  };
  it('send only mapped columns, omit blanks, keep spreadsheet row numbers', () => {
    expect(buildStageRows(sheet, ['employee_no', null, 'phone']).rows).toEqual([
      { row_no: 2, data: { employee_no: 'T1' } },
      { row_no: 4, data: { phone: '98' } },
      { row_no: 5, data: { employee_no: 'T3', phone: '99' } },
    ]);
  });
  it('rows with values only in unmapped columns are not staged; their row numbers are returned', () => {
    const { rows, emptyRows } = buildStageRows(sheet, ['employee_no', null, 'phone']);
    expect(rows.map((r) => r.row_no)).not.toContain(7);
    expect(emptyRows).toEqual([7]);
  });
  it('samples are the first 3 non-empty values', () => {
    expect(sampleValues(sheet, 2)).toEqual(['98', '99']);
    expect(sampleValues(sheet, 0, 1)).toEqual(['T1']);
  });
});

describe('batching', () => {
  const rows = (n: number, size = 1): StageRow[] =>
    Array.from({ length: n }, (_, i) => ({ row_no: i + 2, data: { full_name: 'x'.repeat(size) } }));

  it('splits into batches of at most 500 rows, in order', () => {
    const b = batchRows(rows(1201));
    expect(b.map((x) => x.length)).toEqual([500, 500, 201]);
    expect(b.flat().map((r) => r.row_no)).toEqual(rows(1201).map((r) => r.row_no));
    expect(Math.max(...b.map((x) => x.length))).toBeLessThanOrEqual(STAGE_MAX_ROWS);
  });

  it('also keeps each batch under the byte cap', () => {
    const b = batchRows(rows(500, 4000), 500, 900_000);
    for (const batch of b)
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(900_000);
    expect(b.length).toBeGreaterThan(1);
    expect(b.flat()).toHaveLength(500);
  });

  it('no rows → no batches; one huge row still goes alone', () => {
    expect(batchRows([])).toEqual([]);
    expect(batchRows(rows(1, 2_000_000), 500, 900_000)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ loops
const counts = {
  total: 0,
  ready: 0,
  will_skip: 0,
  needs_fixing: 0,
  created: 0,
  skipped: 0,
  rejected: 0,
  removed: 0,
};
const job: ImportJob = {
  job_id: '88888888-8888-4888-8888-888888888888',
  dataset: 'staff',
  academic_year_id: null,
  academic_year: null,
  file_name: 'staff.csv',
  status: 'committing',
  created_at: '2026-10-18T04:00:00Z',
  created_by: 'Demo Admin',
  updated_at: '2026-10-18T04:00:00Z',
  counts,
};
const chunk = (processed: CommitChunkResult['processed'], more: boolean): CommitChunkResult => ({
  job,
  processed,
  more_ready: more,
});
const created = (n: number) => ({ row_no: n, outcome: 'created' as const, entity_id: job.job_id });

describe('commit loop', () => {
  it('calls again while more_ready and tallies every outcome', async () => {
    const commit = vi
      .fn<() => Promise<CommitChunkResult>>()
      .mockResolvedValueOnce(chunk([created(2), { row_no: 3, outcome: 'skipped' }], true))
      .mockResolvedValueOnce(
        chunk(
          [
            { row_no: 4, outcome: 'rejected', error: 'Roll number already used' },
            { row_no: 5, outcome: 'needs_fixing', errors: [] },
          ],
          false,
        ),
      );
    const onChunk = vi.fn();
    const out = await runCommitLoop(commit, onChunk);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      kind: 'finished',
      tally: { created: 1, skipped: 1, rejected: 1, needsFixing: 1 },
    });
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('stops on an uncertain error (network) and a resumed loop simply continues', async () => {
    const commit = vi
      .fn<() => Promise<CommitChunkResult>>()
      .mockResolvedValueOnce(chunk([created(2)], true))
      .mockRejectedValueOnce(new AppError('NETWORK', 'offline', 'req-1'))
      .mockResolvedValueOnce(chunk([created(3)], false));
    const first = await runCommitLoop(commit, () => undefined);
    expect(first).toMatchObject({ kind: 'uncertain', tally: { created: 1 } });
    expect(commit).toHaveBeenCalledTimes(2);
    const resumed = await runCommitLoop(commit, () => undefined);
    expect(resumed).toMatchObject({ kind: 'finished', tally: { created: 1 } });
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it.each(['UNKNOWN', 'TEMPORARILY_UNAVAILABLE'] as const)('%s is uncertain too', async (code) => {
    const out = await runCommitLoop(
      () => Promise.reject(new AppError(code, 'x', 'r')),
      () => undefined,
    );
    expect(out.kind).toBe('uncertain');
  });

  it('a definite refusal (FORBIDDEN / closed import) is a failure, not "continue"', async () => {
    const out = await runCommitLoop(
      () => Promise.reject(new AppError('VALIDATION_ERROR', 'This import is closed.', 'r')),
      () => undefined,
    );
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'VALIDATION_ERROR' } });
  });

  it('safety net: a chunk that processes nothing while more_ready stops the loop', async () => {
    const commit = vi.fn<() => Promise<CommitChunkResult>>().mockResolvedValue(chunk([], true));
    const out = await runCommitLoop(commit, () => undefined);
    expect(out.kind).toBe('stalled');
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('staging loop', () => {
  const batches: StageRow[][] = [
    [{ row_no: 2, data: {} }],
    [{ row_no: 3, data: {} }],
    [{ row_no: 4, data: {} }],
  ];
  const ok: StageResult = { job_id: job.job_id, counts, already_committed_rows: [] };

  it('a network error stops at that batch; Continue re-sends from the same batch', async () => {
    const sent: number[] = [];
    let fail = true;
    const stage = (rows: StageRow[]) => {
      sent.push(rows[0]!.row_no);
      if (rows[0]!.row_no === 3 && fail) {
        fail = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(ok);
    };
    const first = await runStaging(batches, 0, stage, () => undefined);
    expect(first).toMatchObject({
      kind: 'failed',
      failedBatch: 1,
      resumable: true,
      error: { code: 'NETWORK' },
    });
    if (first.kind !== 'failed') throw new Error('unreachable');
    const progress = vi.fn();
    const second = await runStaging(batches, first.failedBatch, stage, progress);
    expect(second.kind).toBe('done');
    expect(sent).toEqual([2, 3, 3, 4]);
    expect(progress).toHaveBeenLastCalledWith({ batchesDone: 3, rowsDone: 3 });
  });

  it('a definite refusal is not resumable', async () => {
    const out = await runStaging(
      batches,
      0,
      () => Promise.reject(new AppError('FORBIDDEN', 'no', 'r')),
      () => undefined,
    );
    expect(out).toMatchObject({ kind: 'failed', resumable: false });
  });
});

// ------------------------------------------------------------------ templates
describe('template generation from a get_import_template response', () => {
  it('CSV: one header row of labels, quoted where needed, BOM for Excel', () => {
    const t = {
      ...STAFF_TEMPLATE,
      columns: [...COLS, { key: 'x', label: 'Father\'s name, "full"', required: false }],
    };
    const csv = buildTemplateCsv(t);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1)).toBe(
      'Employee no,Full name,Gender,Mobile,Email,Staff group,Designation,Teaching staff?,Joined on,"Father\'s name, ""full"""\r\n',
    );
  });

  it('XLSX: "Data" first with label headers and no example row; "Help" lists required, examples and allowed values', async () => {
    const bytes = await buildTemplateXlsx(STAFF_TEMPLATE, ExcelJS as unknown as ExcelJsModule);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    expect(wb.worksheets.map((w) => w.name)).toEqual([DATA_SHEET, HELP_SHEET]);
    const data = wb.worksheets[0]!;
    expect((data.getRow(1).values as unknown[]).slice(1)).toEqual(COLS.map((c) => c.label));
    expect(data.actualRowCount).toBe(1);
    const helpText = wb.worksheets[1]!.getSheetValues().flat().filter(Boolean).map(String);
    expect(helpText).toEqual(
      expect.arrayContaining(['Gender', 'male, female, transgender', 'Ravi Kumar', 'Yes', 'No']),
    );
    expect(helpText.some((t) => t.includes('Must already exist'))).toBe(true);

    // The template's own headers auto-map back to every column.
    const parsed = await parseXlsx(bytes, ExcelJS as unknown as ExcelJsModule);
    expect(parsed).toEqual({ ok: false, message: expect.stringMatching(/no data rows/) });
    expect(
      autoMap(
        COLS.map((c) => c.label),
        COLS,
      ),
    ).toEqual(COLS.map((c) => c.key));
  });
});
