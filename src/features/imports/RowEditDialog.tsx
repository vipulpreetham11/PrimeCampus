import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import type { ImportRow, TemplateColumn } from '@/contracts/imports';
import { useUpdateImportRow } from './hooks';
import { ROW_STATE_LABELS, rowState } from './labels';

type Values = Record<string, string>;

function valuesOf(row: ImportRow, columns: TemplateColumn[]): Values {
  const v: Values = {};
  for (const c of columns) {
    const x = row.data[c.key];
    v[c.key] = x === null || x === undefined ? '' : String(x);
  }
  return v;
}

/**
 * Edit one draft or rejected row: every template column, with the server's errors under the
 * field they belong to. The server re-checks the row on save (update_import_row); nothing is
 * imported until the user chooses Import.
 */
export function RowEditDialog({
  jobId,
  row: initial,
  columns,
  open,
  onOpenChange,
}: {
  jobId: string;
  row: ImportRow;
  columns: TemplateColumn[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useUpdateImportRow(jobId);
  const [row, setRow] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({ defaultValues: valuesOf(initial, columns) });

  // Server errors appear under their field (FormMessage); row-level ones above the buttons.
  useEffect(() => {
    form.clearErrors();
    for (const e of row.errors) {
      if (e.field && columns.some((c) => c.key === e.field)) {
        form.setError(e.field, { type: 'server', message: e.message });
      }
    }
  }, [row, columns, form]);
  const general = row.errors.filter((e) => !e.field || !columns.some((c) => c.key === e.field));

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const data: Values = {};
    for (const c of columns) {
      const t = (v[c.key] ?? '').trim();
      if (t !== '') data[c.key] = t;
    }
    try {
      const r = await save.mutateAsync({ rowNo: row.row_no, data });
      setRow(r.row);
      const state = rowState(r.row);
      if (state === 'ready' || state === 'will_skip') {
        toast.success(`Row ${r.row.row_no} saved: ${ROW_STATE_LABELS[state]}.`);
        onOpenChange(false);
      }
    } catch (e) {
      setError(e);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit row {row.row_no}</DialogTitle>
          <DialogDescription>
            Changes are made to this import only — fix the spreadsheet too if you will use it again.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {columns.map((c) => (
              <TextField
                key={c.key}
                control={form.control}
                name={c.key}
                label={`${c.label}${c.required ? ' (required)' : ''}`}
                description={[c.allowed ? `Allowed: ${c.allowed.join(', ')}` : '', c.hint ?? '']
                  .filter(Boolean)
                  .join('. ')}
              />
            ))}
            {general.length > 0 && (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/5 text-destructive space-y-1 rounded-md border p-3 text-sm"
              >
                {general.map((e, i) => (
                  <p key={i}>{e.message}</p>
                ))}
              </div>
            )}
            {row.errors.length > 0 && rowState(row) === 'needs_fixing' && row !== initial && (
              <p role="status" className="text-sm">
                Saved, but this row still needs fixing.
              </p>
            )}
            <ErrorText error={error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Checking…' : 'Save and check'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
