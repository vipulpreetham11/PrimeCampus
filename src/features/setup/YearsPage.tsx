import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { DateField, TextField } from '@/components/shared/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AcademicYearRow } from '@/contracts/setup';
import { addDays, compareIsoDates, formatDate } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSaveYear, useSetCurrentYear, useSetupSnapshot } from './hooks';

const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name like 2026-27').max(40),
    start_date: z.string().min(1, 'Choose the first day'),
    end_date: z.string().min(1, 'Choose the last day'),
  })
  .refine((v) => !v.start_date || !v.end_date || compareIsoDates(v.end_date, v.start_date) > 0, {
    path: ['end_date'],
    message: 'The year must end after it starts',
  })
  .refine(
    (v) => !v.start_date || !v.end_date || compareIsoDates(v.end_date, addDays(v.start_date, 550)) <= 0,
    {
      path: ['end_date'],
      message: 'An academic year can be at most 550 days long',
    },
  );
type Values = z.infer<typeof schema>;

function YearDialog({
  year,
  open,
  onOpenChange,
  onReload,
}: {
  year: AcademicYearRow | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  const save = useSaveYear();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: year
      ? { name: year.name, start_date: year.start_date, end_date: year.end_date }
      : { name: '', start_date: '', end_date: '' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({ ...v, ...(year ? { id: year.id, version: year.version } : {}) });
      toast.success(year ? 'Academic year updated.' : 'Academic year created.');
      onOpenChange(false);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{year ? `Edit ${year.name}` : 'New academic year'}</DialogTitle>
          <DialogDescription>
            Years cannot overlap. Making a year current is a separate step.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField control={form.control} name="name" label="Name" placeholder="2026-27" />
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField control={form.control} name="start_date" label="First day" />
              <DateField control={form.control} name="end_date" label="Last day" />
            </div>
            <ErrorText error={error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function YearsPage() {
  const query = useSetupSnapshot(null);
  const canManage = useCan('setup.manage');
  const setCurrent = useSetCurrentYear();
  // Keep only the id: the dialog reads the latest row and is keyed on its version (CONFLICT → refetch → fresh form).
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = query.data?.academic_years.find((y) => y.id === editingId) ?? null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<AcademicYearRow | null>(null);
  const [error, setError] = useState<unknown>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Academic years</CardTitle>
        {canManage && (
          <Button
            size="sm"
            onClick={() => {
              setEditingId(null);
              setDialogOpen(true);
            }}
          >
            New year
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorText error={error} />
        <DataState
          query={query}
          isEmpty={(d) => d.academic_years.length === 0}
          emptyTitle="No academic years yet"
          emptyDescription={canManage ? 'Create the first year, then make it current.' : undefined}
        >
          {(snap) => (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Year</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Status</TableHead>
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.academic_years.map((y) => (
                    <TableRow key={y.id} data-testid={`year-row-${y.name}`}>
                      <TableCell className="font-medium">{y.name}</TableCell>
                      <TableCell>{formatDate(y.start_date)}</TableCell>
                      <TableCell>{formatDate(y.end_date)}</TableCell>
                      <TableCell>
                        {y.is_current ? (
                          <Badge>Current</Badge>
                        ) : (
                          <span className="capitalize">{y.status}</span>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell className="space-x-2 text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingId(y.id);
                              setDialogOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          {!y.is_current && (
                            <Button size="sm" variant="outline" onClick={() => setConfirm(y)}>
                              Make current
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DataState>
      </CardContent>
      {dialogOpen && (editingId === null || editing) && (
        <YearDialog
          key={editing?.version ?? 'new'}
          year={editing}
          open
          onOpenChange={setDialogOpen}
          onReload={() => void query.refetch()}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Make ${confirm?.name ?? ''} the current year?`}
        description="This changes the default year everyone sees in setup, attendance and fees screens. It does not promote students or hide old dues."
        confirmLabel="Make current"
        busy={setCurrent.isPending}
        onConfirm={async () => {
          if (!confirm) return;
          setError(null);
          try {
            await setCurrent.mutateAsync(confirm.id);
            toast.success(`${confirm.name} is now the current year.`);
          } catch (e) {
            setError(handleSaveError(e));
          } finally {
            setConfirm(null);
          }
        }}
      />
    </Card>
  );
}
