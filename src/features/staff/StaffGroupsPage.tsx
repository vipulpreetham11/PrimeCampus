import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { MoneyField, SelectField, TextField } from '@/components/shared/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { StaffGroup } from '@/contracts/staff';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSaveStaffGroup, useStaffGroups, useStaffGroupsWithSalary } from './hooks';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a group name').max(80),
  status: z.enum(['active', 'retired']),
  default_salary_paise: z.number().int().min(0).max(100000000000).nullable(),
});
type Values = z.infer<typeof schema>;

function GroupDialog({
  group,
  open,
  onOpenChange,
  onReload,
}: {
  group: StaffGroup | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  // Salary: visible only with staff_finance.read, editable only with staff_finance.manage (brief §2.1).
  const canSeeSalary = useCan('staff_finance.read');
  const canEditSalary = useCan('staff_finance.manage');
  const save = useSaveStaffGroup();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: group
      ? { name: group.name, status: group.status, default_salary_paise: group.default_monthly_salary_paise }
      : { name: '', status: 'active', default_salary_paise: null },
  });
  const existingSalary = group?.default_monthly_salary_paise ?? null;
  // "Clear default salary" is applied by Save, with the group's version like every other change.
  const [clearSalary, setClearSalary] = useState(false);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    // An emptied amount field is not a removal: the server keeps the old default when none is sent.
    if (canEditSalary && !clearSalary && existingSalary !== null && v.default_salary_paise === null) {
      form.setError('default_salary_paise', {
        message: 'Enter an amount, or use “Clear default salary” to remove it.',
      });
      return;
    }
    const salaryChanged = canEditSalary && !clearSalary && v.default_salary_paise !== existingSalary;
    try {
      await save.mutateAsync({
        name: v.name,
        status: v.status,
        default_salary_paise: salaryChanged ? v.default_salary_paise : null,
        clear_default_salary: canEditSalary && clearSalary,
        ...(group ? { id: group.id, version: group.version } : {}),
      });
      toast.success(group ? 'Staff group saved.' : 'Staff group created.');
      onOpenChange(false);
    } catch (e) {
      setError(
        handleSaveError(e, { reload: onReload, form, fields: { default_salary: 'default_salary_paise' } }),
      );
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : 'New staff group'}</DialogTitle>
          <DialogDescription>
            Groups organise staff calendars and default pay. A group is a category, not a login role.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField control={form.control} name="name" label="Name" placeholder="Teaching staff" />
            {group && (
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
            {canSeeSalary && !clearSalary && (
              <MoneyField
                control={form.control}
                name="default_salary_paise"
                label="Default monthly salary"
                description={
                  !canEditSalary
                    ? 'Read-only for your role.'
                    : existingSalary === null
                      ? 'No default salary. Used when a staff member has no own rate. Confidential.'
                      : 'Used when a staff member has no own rate. Confidential.'
                }
                disabled={!canEditSalary}
              />
            )}
            {canEditSalary && existingSalary !== null && !clearSalary && (
              <Button type="button" variant="outline" size="sm" onClick={() => setClearSalary(true)}>
                Clear default salary
              </Button>
            )}
            {clearSalary && (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <span>
                  The default salary (<MoneyText paise={existingSalary} />) will be removed when you save. The
                  group will have no default salary — not ₹0.
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setClearSalary(false)}>
                  Undo
                </Button>
              </div>
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

export function StaffGroupsPage() {
  const canManage = useCan('setup.manage');
  const canSeeSalary = useCan('staff_finance.read');
  // Finance roles read the salary through its own finance-scoped query; everyone else the shared one.
  const plain = useStaffGroups(!canSeeSalary, true);
  const withSalary = useStaffGroupsWithSalary(canSeeSalary, true);
  const groups = canSeeSalary ? withSalary : plain;
  // Keep only the id: the dialog reads the latest row and is keyed on its version (CONFLICT → refetch → fresh form).
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = groups.data?.find((g) => g.id === editingId) ?? null;
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              setEditingId(null);
              setOpen(true);
            }}
          >
            New staff group
          </Button>
        </div>
      )}
      <DataState query={groups} isEmpty={(d) => d.length === 0} emptyTitle="No staff groups yet">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Active staff</TableHead>
                {canSeeSalary && <TableHead>Default monthly salary</TableHead>}
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <TableRow key={g.id} data-testid={`group-row-${g.name}`}>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell>{g.staff_count}</TableCell>
                  {canSeeSalary && (
                    <TableCell data-testid="group-salary">
                      <MoneyText paise={g.default_monthly_salary_paise} missing="No default salary" />
                    </TableCell>
                  )}
                  <TableCell>
                    {g.status === 'active' ? 'Active' : <Badge variant="outline">Retired</Badge>}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingId(g.id);
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
      {open && (editingId === null || editing) && (
        <GroupDialog
          key={editing?.version ?? 'new'}
          group={editing}
          open
          onOpenChange={setOpen}
          onReload={() => void groups.refetch()}
        />
      )}
    </div>
  );
}
