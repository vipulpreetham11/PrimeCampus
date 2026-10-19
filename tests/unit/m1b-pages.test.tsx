import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { contextSchema } from '@/contracts/session';
import { fakeSupabase, contextRow, onRpc, resetFake, rpcCalls, setupSnapshotRow } from './fake-supabase';
import { countsRow, JOB_ID, jobRow, rowRow, STAFF_1, staffTemplateRow } from './m1b-fixtures';
import { setContext } from './render';

vi.mock('@/lib/supabase', () => ({ supabase: fakeSupabase }));

const { NewImportPage } = await import('@/features/imports/NewImportPage');
const { ImportJobPage } = await import('@/features/imports/ImportJobPage');
const { ImportsPage } = await import('@/features/imports/ImportsPage');
const { buildNav } = await import('@/app/navigation');
const { RequireCapability } = await import('@/app/RequireCapability');

// Capabilities exactly as private.role_has_cap grants them (migration 0800).
const TEACHER = ['staff.member', 'timetable.read_all', 'staff.read'];
const ADMIN = [
  'staff.member',
  'setup.manage',
  'users.manage',
  'students.read_all',
  'students.manage',
  'admissions.manage',
  'imports.manage',
  'staff.read',
  'staff.manage',
];

const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const NETWORK_ERROR = { error: { message: 'TypeError: Failed to fetch' } };

/** Data router (the wizard uses useBlocker), memory-only query client. */
function renderRoutes(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/imports', element: <ImportsPage /> },
      { path: '/imports/new', element: <NewImportPage /> },
      { path: '/imports/:jobId', element: <ImportJobPage /> },
      { path: '*', element: <p>other page</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { qc, router };
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  resetFake();
  setContext(ADMIN, 'admin');
});

// ------------------------------------------------------------------ access
describe('Imports is offered only with imports.manage', () => {
  const labels = (caps: string[], role: string) =>
    buildNav(contextSchema.parse(contextRow(1, role, caps)), false)
      .filter((i) => i.kind === 'live')
      .map((i) => i.label);

  it('admin sees Imports; teacher does not', () => {
    expect(labels(ADMIN, 'admin')).toContain('Imports');
    expect(labels(TEACHER, 'teacher')).not.toContain('Imports');
  });

  it('opening /imports without the capability shows "no access", not the screen', () => {
    setContext(TEACHER, 'teacher');
    const router = createMemoryRouter(
      [
        {
          element: <RequireCapability anyOf={['imports.manage']} />,
          children: [{ path: '/imports', element: <ImportsPage /> }],
        },
      ],
      { initialEntries: ['/imports'] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("You don't have access to this page");
    expect(calls('list_import_jobs')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ history
describe('imports history', () => {
  it('lists jobs with dataset, file, status and counts, plus the recommended order', async () => {
    onRpc((fn) =>
      fn === 'list_import_jobs'
        ? {
            data: [
              jobRow({
                status: 'partially_completed',
                counts: countsRow({ created: 3, skipped: 1, rejected: 1 }),
              }),
            ],
          }
        : { data: null },
    );
    renderRoutes('/imports');
    const item = await screen.findByTestId(`import-job-${JOB_ID}`);
    expect(item).toHaveTextContent('Staff');
    expect(item).toHaveTextContent('staff.csv');
    expect(item).toHaveTextContent('Closed — some rows not imported');
    expect(item).toHaveTextContent('3 imported · 1 already existed · 1 not imported');
    expect(screen.getByRole('list', { name: 'Recommended import order' })).toHaveTextContent(
      /Classes & sections.*Staff.*staff groups must exist first.*Students & parents.*Placements/,
    );
  });
});

// ------------------------------------------------------------------ wizard
describe('new import wizard', () => {
  const CSV =
    'Employee no,Full name,Staff group,Mobile,Joined on\nT1,Ravi,Teaching staff,9876543210,01/06/2026\n\nT2,Meera,Teaching staff,123,2026-06-01\n';

  async function chooseStaffAndUpload(text: string, name = 'staff.csv') {
    const user = userEvent.setup();
    renderRoutes('/imports/new');
    await user.click(screen.getByRole('radio', { name: /^Staff/ }));
    await screen.findByRole('button', { name: /Download template \(\.xlsx\)/ });
    await user.upload(
      screen.getByLabelText('Spreadsheet file (.xlsx or .csv)'),
      new File([text], name, { type: 'text/csv' }),
    );
    return user;
  }

  it('required columns must be mapped before anything is sent', async () => {
    onRpc((fn) =>
      fn === 'get_import_template' ? { data: staffTemplateRow() } : { data: setupSnapshotRow() },
    );
    await chooseStaffAndUpload('Employee no,Full name,Mobile\nT1,Ravi,9876543210\n');
    expect(await screen.findByText('Choose a file column for: Staff group, Joined on.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload rows for checking' })).toBeDisabled();
    // Samples are shown per file column
    expect(screen.getByText('9876543210')).toBeInTheDocument();
  });

  it('start → stage: fingerprint, one operation id reused on retry, Continue re-sends the failed batch', async () => {
    let startCalls = 0;
    let stageCalls = 0;
    onRpc((fn) => {
      if (fn === 'get_import_template') return { data: staffTemplateRow() };
      if (fn === 'get_setup_snapshot') return { data: setupSnapshotRow() };
      if (fn === 'start_import') {
        startCalls += 1;
        if (startCalls === 1) return NETWORK_ERROR;
        return {
          data: {
            ...jobRow(),
            same_file_before: [
              { job_id: STAFF_1, created_at: '2026-10-05T03:35:00+00:00', status: 'completed' },
            ],
          },
        };
      }
      if (fn === 'stage_import_rows') {
        stageCalls += 1;
        if (stageCalls === 1) return NETWORK_ERROR;
        return {
          data: {
            job_id: JOB_ID,
            counts: countsRow({ total: 2, ready: 1, needs_fixing: 1 }),
            already_committed_rows: [],
          },
        };
      }
      return { data: null };
    });
    const user = await chooseStaffAndUpload(CSV);
    expect(await screen.findByText('All required columns are matched.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upload rows for checking' }));

    // Network failure on start → same id on retry
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    const starts = calls('start_import');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.args!.p_operation_id).toBe(starts[0]!.args!.p_operation_id);
    expect(starts[0]!.args).toMatchObject({
      p_dataset: 'staff',
      p_academic_year_id: null,
      p_file_name: 'staff.csv',
      p_source_fingerprint: await sha256(CSV),
    });
    // The mapping records headers only, never cell values
    expect(JSON.stringify(starts[0]!.args!.p_mapping)).not.toContain('Ravi');

    // Earlier import of the same file
    expect(
      await screen.findByText(/This file was imported on 5 Oct 2026.*won't create duplicates/),
    ).toBeInTheDocument();

    // Staging failed → Continue re-sends the same rows to the same job
    await user.click(await screen.findByRole('button', { name: 'Continue uploading' }));
    expect(
      await screen.findByText(
        /All 2 rows are uploaded and checked\. 1 ready, 0 already exist, 1 need fixing/,
      ),
    ).toBeInTheDocument();
    const stages = calls('stage_import_rows');
    expect(stages).toHaveLength(2);
    expect(stages[1]!.args).toEqual(stages[0]!.args);
    expect(stages[0]!.args).toMatchObject({
      p_job_id: JOB_ID,
      p_rows: [
        {
          row_no: 2,
          data: {
            employee_no: 'T1',
            full_name: 'Ravi',
            staff_group: 'Teaching staff',
            phone: '9876543210',
            joined_on: '01/06/2026',
          },
        },
        {
          row_no: 4,
          data: {
            employee_no: 'T2',
            full_name: 'Meera',
            staff_group: 'Teaching staff',
            phone: '123',
            joined_on: '2026-06-01',
          },
        },
      ],
    });
    expect(screen.getByRole('link', { name: 'Review rows' })).toHaveAttribute('href', `/imports/${JOB_ID}`);
  });

  it('rows with data only in unmapped columns are not sent, and the user is told before upload', async () => {
    onRpc((fn) => {
      if (fn === 'get_import_template') return { data: staffTemplateRow() };
      if (fn === 'start_import') return { data: { ...jobRow(), same_file_before: [] } };
      if (fn === 'stage_import_rows') {
        return {
          data: { job_id: JOB_ID, counts: countsRow({ total: 1, ready: 1 }), already_committed_rows: [] },
        };
      }
      return { data: setupSnapshotRow() };
    });
    const user = await chooseStaffAndUpload(
      'Employee no,Full name,Staff group,Joined on,Notes\nT1,Ravi,Teaching staff,2026-06-01,\n,,,,only a note\n',
    );
    expect(
      await screen.findByText(/1 row had no data in the mapped columns and was skipped \(row 3\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/^1 row will be checked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upload rows for checking' }));
    expect(await screen.findByText(/All 1 rows are uploaded and checked/)).toBeInTheDocument();
    expect(
      (calls('stage_import_rows')[0]!.args!.p_rows as { row_no: number }[]).map((r) => r.row_no),
    ).toEqual([2]);
  });

  it('a CSV with one unreadable byte shows which rows to check', async () => {
    onRpc((fn) =>
      fn === 'get_import_template' ? { data: staffTemplateRow() } : { data: setupSnapshotRow() },
    );
    const user = userEvent.setup();
    renderRoutes('/imports/new');
    await user.click(screen.getByRole('radio', { name: /^Staff/ }));
    const enc = new TextEncoder();
    const bytes = new Uint8Array([
      ...enc.encode(
        'Employee no,Full name,Staff group,Joined on\nT1,రవి,Teaching staff,2026-06-01\nT2,Meera ',
      ),
      0x96,
      ...enc.encode(',Teaching staff,2026-06-01\n'),
    ]);
    await user.upload(
      screen.getByLabelText('Spreadsheet file (.xlsx or .csv)'),
      new File([bytes], 'staff.csv'),
    );
    expect(await screen.findByText(/could not be read and show as � in row 3\./)).toBeInTheDocument();
    expect(screen.getByText('రవి', { exact: false })).toBeInTheDocument();
  });

  it('a file that is not a spreadsheet is refused with a plain message', async () => {
    onRpc((fn) =>
      fn === 'get_import_template' ? { data: staffTemplateRow() } : { data: setupSnapshotRow() },
    );
    const user = userEvent.setup({ applyAccept: false });
    renderRoutes('/imports/new');
    await user.click(screen.getByRole('radio', { name: /^Staff/ }));
    await user.upload(screen.getByLabelText('Spreadsheet file (.xlsx or .csv)'), new File(['x'], 'old.xls'));
    expect(await screen.findByText(/old\.xls can't be used/)).toBeInTheDocument();
    expect(calls('start_import')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ job page
describe('import job page', () => {
  const needsFixing = rowRow({
    row_no: 3,
    data: {
      employee_no: 'T2',
      full_name: 'Meera Rao',
      staff_group: 'Science',
      phone: '123',
      joined_on: '2026-06-01',
    },
    errors: [
      { field: 'phone', message: 'Use a 10-digit mobile number' },
      { field: 'staff_group', message: 'No active staff group named "Science". Create it first.' },
    ],
  });
  const page = (over: Record<string, unknown> = {}, rows = [rowRow(), needsFixing]) => ({
    job: jobRow({ counts: countsRow({ total: 3, ready: 1, will_skip: 1, needs_fixing: 1 }), ...over }),
    columns: staffTemplateRow().columns,
    rows,
    next_cursor: null,
  });

  it('tiles show text + numbers; errors sit next to their field; remove says no record is deleted', async () => {
    onRpc((fn) => (fn === 'get_import_job' ? { data: page() } : { data: null }));
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    expect(await screen.findByTestId('tile-Ready')).toHaveTextContent('Ready1Will be created');
    expect(screen.getByTestId('tile-Already exist')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-Needs fixing')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-Not imported')).toHaveTextContent('0');

    const row3 = screen.getByTestId('import-row-3');
    expect(row3).toHaveTextContent('Needs fixing');
    // identifying field: message right under the value; other fields: "Label: message"
    expect(within(row3).getByText('Science').nextSibling).toHaveTextContent(
      'No active staff group named "Science"',
    );
    expect(row3).toHaveTextContent('Mobile: Use a 10-digit mobile number');

    await user.click(within(row3).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Removing a row never deletes a school record',
    );
  });

  it('filter tabs are the server filters and are sent to get_import_job', async () => {
    onRpc((fn) => (fn === 'get_import_job' ? { data: page() } : { data: null }));
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    await user.click(await screen.findByRole('tab', { name: 'Not imported (0)' }));
    await waitFor(() => expect(calls('get_import_job').at(-1)!.args).toMatchObject({ p_filter: 'rejected' }));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All rows',
      'Ready (1)',
      'Already exist (1)',
      'Needs fixing (1)',
      'Imported (0)',
      'Skipped (already existed) (0)',
      'Not imported (0)',
      'Removed (0)',
    ]);
  });

  it('outage: commit AND the background refresh fail → the Continue warning survives; numbers come from the latest commit', async () => {
    let commits = 0;
    let outage = false;
    onRpc((fn) => {
      if (fn === 'get_import_job') return outage ? NETWORK_ERROR : { data: page() };
      if (fn === 'commit_import_chunk') {
        commits += 1;
        if (commits === 1) {
          outage = true; // the network is down: the refresh after the failed commit fails too
          return NETWORK_ERROR;
        }
        // back for the commit only; get_import_job keeps failing, so the page counts stay stale
        return {
          data: {
            job: jobRow({
              status: 'committing',
              updated_at: '2026-10-18T04:05:00+00:00',
              counts: countsRow({ total: 3, created: 1, skipped: 1, needs_fixing: 1 }),
            }),
            processed: [
              { row_no: 1, outcome: 'skipped', entity_id: STAFF_1 },
              { row_no: 2, outcome: 'created', entity_id: STAFF_1 },
            ],
            more_ready: false,
          },
        };
      }
      return { data: null };
    });
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Import 1 row' }));

    // The failed refresh doesn't unmount the panel: both the warning and the stale-data note show.
    expect(await screen.findByText(/This import couldn.t be refreshed/)).toBeInTheDocument();
    expect(
      screen.getByText('Some rows may already be imported — choose Continue to resume.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tile-Ready')).toHaveTextContent('1');
    await waitFor(() => expect(calls('get_import_job').length).toBeGreaterThan(1));
    expect(
      screen.getByText('Some rows may already be imported — choose Continue to resume.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'This run: 1 imported, 1 already existed (nothing changed), 0 not imported, 0 need fixing.',
      ),
    ).toBeInTheDocument();
    // From the commit response (the page's own copy still says Ready 1 / Imported 0)
    expect(screen.getByText(/Still to do: 1 need fixing, 0 not imported/)).toBeInTheDocument();
    expect(screen.getByTestId('tile-Imported')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-Ready')).toHaveTextContent('0');
    expect(screen.queryByText(/All rows in this import are done/)).not.toBeInTheDocument();
    expect(calls('commit_import_chunk').map((c) => c.args)).toEqual([
      { p_job_id: JOB_ID, p_limit: 100, p_ctx_rev: 1 },
      { p_job_id: JOB_ID, p_limit: 100, p_ctx_rev: 1 },
    ]);
  });

  it('while a run is in progress: filter tabs, Edit, Remove and Close import are disabled', async () => {
    let release: () => void = () => undefined;
    onRpc((fn) => {
      if (fn === 'get_import_job') return { data: page() };
      if (fn === 'commit_import_chunk') {
        return new Promise((resolve) => {
          release = () =>
            resolve({
              data: {
                job: jobRow({
                  status: 'committing',
                  counts: countsRow({ total: 3, created: 1, needs_fixing: 1, skipped: 1 }),
                }),
                processed: [{ row_no: 2, outcome: 'created', entity_id: STAFF_1 }],
                more_ready: false,
              },
            });
        });
      }
      return { data: null };
    });
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Import 1 row' }));
    expect(await screen.findByRole('progressbar', { name: 'Importing rows…' })).toBeInTheDocument();
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled();
    const row3 = screen.getByTestId('import-row-3');
    expect(within(row3).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(row3).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close import' })).toBeDisabled();
    release();
    expect(await screen.findByText(/^This run: 1 imported/)).toBeInTheDocument();
    expect(screen.getAllByRole('tab')[0]).toBeEnabled();
  });

  it('only existing rows left (nothing to fix): "Confirm" with the re-check wording', async () => {
    onRpc((fn) =>
      fn === 'get_import_job'
        ? { data: page({ counts: countsRow({ total: 2, will_skip: 2 }) }, [rowRow({ action: 'skip' })]) }
        : { data: null },
    );
    renderRoutes(`/imports/${JOB_ID}`);
    expect(await screen.findByRole('button', { name: 'Confirm 2 existing rows' })).toBeEnabled();
    expect(
      screen.getByText(
        'These rows already exist. Confirming re-checks them; anything missing now will be created.',
      ),
    ).toBeInTheDocument();
  });

  it('a chunk that processes nothing shows the neutral reload message', async () => {
    onRpc((fn) => {
      if (fn === 'get_import_job') return { data: page() };
      if (fn === 'commit_import_chunk') {
        return {
          data: {
            job: jobRow({ counts: countsRow({ total: 3, ready: 1, will_skip: 1, needs_fixing: 1 }) }),
            processed: [],
            more_ready: true,
          },
        };
      }
      return { data: null };
    });
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Import 1 row' }));
    expect(
      await screen.findByText('No rows were processed. Reload the import and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // M2X: Reload goes back to the job's real state — the notice goes, Import is offered again
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        screen.queryByText('No rows were processed. Reload the import and try again.'),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: 'Import 1 row' })).toBeEnabled();
  });

  it('a role without the dataset capability (staff.manage) cannot start the import, and is told why', async () => {
    setContext(
      ADMIN.filter((c) => c !== 'staff.manage'),
      'admin',
    );
    onRpc((fn) => (fn === 'get_import_job' ? { data: page() } : { data: null }));
    renderRoutes(`/imports/${JOB_ID}`);
    expect(await screen.findByRole('button', { name: 'Import 1 row' })).toBeDisabled();
    expect(screen.getByText(/Your role can't import staff\./)).toBeInTheDocument();
  });

  it('pending rows (allowed by the table) parse and show as "Being imported"', async () => {
    onRpc((fn) =>
      fn === 'get_import_job' ? { data: page({}, [rowRow({ status: 'pending' })]) } : { data: null },
    );
    renderRoutes(`/imports/${JOB_ID}`);
    const row = await screen.findByTestId('import-row-2');
    expect(row).toHaveTextContent('Being imported');
    expect(within(row).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('Import is disabled when nothing is ready or existing', async () => {
    onRpc((fn) =>
      fn === 'get_import_job'
        ? { data: page({ counts: countsRow({ total: 1, needs_fixing: 1 }) }, [needsFixing]) }
        : { data: null },
    );
    renderRoutes(`/imports/${JOB_ID}`);
    expect(await screen.findByRole('button', { name: 'Import 0 rows' })).toBeDisabled();
  });

  it('edit dialog: every template column, server errors under the field, saves the whole row', async () => {
    onRpc((fn, args) => {
      if (fn === 'get_import_job') return { data: page() };
      if (fn === 'update_import_row') {
        return {
          data: {
            row: rowRow({ row_no: 3, data: args!.p_data, errors: [] }),
            counts: countsRow({ total: 3, ready: 2, will_skip: 1 }),
          },
        };
      }
      return { data: null };
    });
    const user = userEvent.setup();
    renderRoutes(`/imports/${JOB_ID}`);
    await user.click(within(await screen.findByTestId('import-row-3')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    for (const label of [
      'Employee no (required)',
      'Gender',
      'Mobile',
      'Email',
      'Designation',
      'Teaching staff?',
      'Joined on (required)',
    ]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByText('Use a 10-digit mobile number')).toBeInTheDocument();
    const mobile = within(dialog).getByLabelText('Mobile');
    await user.clear(mobile);
    await user.type(mobile, '9876543211');
    const group = within(dialog).getByLabelText('Staff group (required)');
    await user.clear(group);
    await user.type(group, 'Teaching staff');
    await user.click(within(dialog).getByRole('button', { name: 'Save and check' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls('update_import_row')[0]!.args).toEqual({
      p_job_id: JOB_ID,
      p_row_no: 3,
      p_ctx_rev: 1,
      p_data: {
        employee_no: 'T2',
        full_name: 'Meera Rao',
        staff_group: 'Teaching staff',
        phone: '9876543211',
        joined_on: '2026-06-01',
      },
    });
  });

  it('closed imports are read-only; created rows link to the new record', async () => {
    onRpc((fn) =>
      fn === 'get_import_job'
        ? {
            data: page({ status: 'completed', counts: countsRow({ total: 1, created: 1 }) }, [
              rowRow({ status: 'committed', action: 'create', result_entity_id: STAFF_1 }),
            ]),
          }
        : { data: null },
    );
    renderRoutes(`/imports/${JOB_ID}`);
    expect(await screen.findByText(/This import is closed and read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close import' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open staff profile' })).toHaveAttribute(
      'href',
      `/staff/${STAFF_1}`,
    );
  });
});
