import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { CheckboxField, DateField, SelectField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import type { StaffGroup, StaffRecord } from '@/contracts/staff';
import { compareIsoDates, schoolToday } from '@/lib/dates';
import { blankToNull, changedFields, handleSaveError } from '@/lib/save-feedback';
import { useSaveStaff, type StaffInput } from './hooks';

// Mirrors app.staff CHECK constraints.
const schema = z
  .object({
    employee_no: z.string().trim().min(1, 'Enter the employee number').max(40),
    full_name: z.string().trim().min(1, 'Enter the name').max(200),
    gender: z.string(),
    phone: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[0-9]{10}$/.test(v), '10-digit mobile number'),
    email: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid email'),
    staff_group_id: z.string().min(1, 'Choose a staff group'),
    designation: z.string().trim().max(80),
    is_teaching: z.boolean(),
    joined_on: z.string().min(1, 'Choose the joining date'),
    left_on: z.string(),
    status: z.enum(['active', 'inactive']),
  })
  .refine((v) => !v.left_on || !v.joined_on || compareIsoDates(v.left_on, v.joined_on) >= 0, {
    path: ['left_on'],
    message: 'Leaving date cannot be before the joining date',
  });
type Values = z.infer<typeof schema>;

const NO_GENDER = 'unspecified';

function toInput(v: Values): StaffInput {
  return {
    employee_no: v.employee_no.trim(),
    full_name: v.full_name.trim(),
    gender: v.gender === NO_GENDER ? null : v.gender,
    phone: blankToNull(v.phone),
    email: blankToNull(v.email),
    staff_group_id: v.staff_group_id,
    designation: blankToNull(v.designation),
    is_teaching: v.is_teaching,
    joined_on: v.joined_on,
    left_on: blankToNull(v.left_on),
    status: v.status,
  };
}

function fromRecord(r: StaffRecord): Values {
  return {
    employee_no: r.employee_no,
    full_name: r.full_name,
    gender: r.gender ?? NO_GENDER,
    phone: r.phone ?? '',
    email: r.email ?? '',
    staff_group_id: r.staff_group_id,
    designation: r.designation ?? '',
    is_teaching: r.is_teaching,
    joined_on: r.joined_on,
    left_on: r.left_on ?? '',
    status: r.status,
  };
}

export function StaffFormDialog({
  record,
  groups,
  open,
  onOpenChange,
  onSaved,
  onReload,
}: {
  record: StaffRecord | null;
  groups: StaffGroup[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (staffId: string) => void;
  onReload?: () => void;
}) {
  const save = useSaveStaff();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    values: record
      ? fromRecord(record)
      : {
          employee_no: '',
          full_name: '',
          gender: NO_GENDER,
          phone: '',
          email: '',
          staff_group_id: groups.length === 1 ? groups[0]!.id : '',
          designation: '',
          is_teaching: false,
          joined_on: schoolToday(),
          left_on: '',
          status: 'active',
        },
  });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const next = toInput(v);
    // On edit send only what changed, so fields the server keeps (and we don't show) are untouched.
    const p = record ? changedFields(toInput(fromRecord(record)), next) : next;
    if (record && Object.keys(p).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      const res = await save.mutateAsync({
        p,
        ...(record ? { id: record.staff_id, version: record.version } : {}),
      });
      toast.success(record ? 'Staff record saved.' : 'Staff record created.');
      onOpenChange(false);
      onSaved?.(res.staff_id);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload }));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{record ? `Edit ${record.full_name}` : 'New staff member'}</DialogTitle>
          <DialogDescription>
            Salary and bank details are kept separately and are not part of this form.
          </DialogDescription>
        </DialogHeader>
        {groups.length === 0 ? (
          <p className="text-sm">Create a staff group first (Staff groups tab).</p>
        ) : (
          <Form {...form}>
            <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
              <TextField
                control={form.control}
                name="full_name"
                label="Full name"
                className="sm:col-span-2"
              />
              <TextField control={form.control} name="employee_no" label="Employee number" />
              <SelectField
                control={form.control}
                name="staff_group_id"
                label="Staff group"
                options={groups.map((g) => ({ value: g.id, label: g.name }))}
              />
              <TextField
                control={form.control}
                name="designation"
                label="Designation"
                placeholder="TGT Maths"
              />
              <SelectField
                control={form.control}
                name="gender"
                label="Gender"
                options={[
                  { value: NO_GENDER, label: 'Not recorded' },
                  { value: 'female', label: 'Female' },
                  { value: 'male', label: 'Male' },
                  { value: 'transgender', label: 'Transgender' },
                ]}
              />
              <TextField control={form.control} name="phone" label="Mobile" type="tel" inputMode="numeric" />
              <TextField control={form.control} name="email" label="Email" type="email" />
              <DateField control={form.control} name="joined_on" label="Joined on" />
              {record && <DateField control={form.control} name="left_on" label="Left on (optional)" />}
              {record && (
                <SelectField
                  control={form.control}
                  name="status"
                  label="Status"
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ]}
                />
              )}
              <CheckboxField
                control={form.control}
                name="is_teaching"
                label="Teaching staff"
                description="Teachers can be given classes, subjects and class-teacher duty."
                className="sm:col-span-2"
              />
              <div className="space-y-3 sm:col-span-2">
                <ErrorText error={error} />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
