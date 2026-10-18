import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { SelectField, TextField } from '@/components/shared/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { SubjectRow } from '@/contracts/setup';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSaveSubject, useSetupSnapshot } from './hooks';

// Mirrors app.subjects checks: name 1–80, code ^[A-Za-z0-9_-]{1,20}$
const schema = z.object({
  name: z.string().trim().min(1, 'Enter a subject name').max(80),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, '1–20 letters, digits, - or _ (e.g. MATH)'),
  status: z.enum(['active', 'retired']),
});
type Values = z.infer<typeof schema>;

function SubjectDialog({
  subject,
  open,
  onOpenChange,
  onReload,
}: {
  subject: SubjectRow | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  const save = useSaveSubject();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: subject
      ? { name: subject.name, code: subject.code, status: subject.status }
      : { name: '', code: '', status: 'active' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({ ...v, ...(subject ? { id: subject.id, version: subject.version } : {}) });
      toast.success(subject ? 'Subject updated.' : 'Subject created.');
      onOpenChange(false);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload }));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{subject ? `Edit ${subject.name}` : 'New subject'}</DialogTitle>
          <DialogDescription>Retiring a subject keeps its history; it is never deleted.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField control={form.control} name="name" label="Name" placeholder="Mathematics" />
            <TextField control={form.control} name="code" label="Code" placeholder="MATH" />
            {subject && (
              <SelectField
                control={form.control}
                name="status"
                label="Status"
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'retired', label: 'Retired (kept for history)' },
                ]}
              />
            )}
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

export function SubjectsPage() {
  const query = useSetupSnapshot(null);
  const canManage = useCan('setup.manage');
  // Keep only the id: the dialog reads the latest row and is keyed on its version (CONFLICT → refetch → fresh form).
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = query.data?.subjects.find((s) => s.id === editingId) ?? null;
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Subjects</CardTitle>
        {canManage && (
          <Button
            size="sm"
            onClick={() => {
              setEditingId(null);
              setOpen(true);
            }}
          >
            New subject
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <DataState query={query} isEmpty={(d) => d.subjects.length === 0} emptyTitle="No subjects yet">
          {(snap) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {snap.subjects.map((s) => (
                  <TableRow key={s.id} data-testid={`subject-row-${s.code}`}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="font-mono">{s.code}</TableCell>
                    <TableCell>
                      {s.status === 'active' ? 'Active' : <Badge variant="outline">Retired</Badge>}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingId(s.id);
                            setOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DataState>
      </CardContent>
      {open && (editingId === null || editing) && (
        <SubjectDialog
          key={editing?.version ?? 'new'}
          subject={editing}
          open
          onOpenChange={setOpen}
          onReload={() => void query.refetch()}
        />
      )}
    </Card>
  );
}
