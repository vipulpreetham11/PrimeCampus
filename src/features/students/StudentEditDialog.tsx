import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from '@/lib/zod';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { SelectField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { STUDENT_STATUSES, type StudentCore } from '@/contracts/students';
import { changedFields, handleSaveError } from '@/lib/save-feedback';
import { useUpdateStudent } from './hooks';
import {
  StudentFieldsSections,
  nationalityIssue,
  nationalityRule,
  studentFieldsFrom,
  studentFieldsShape,
  studentPayload,
} from './student-fields';

const schema = z
  .object({ ...studentFieldsShape, status: z.enum(STUDENT_STATUSES) })
  .refine(nationalityRule, nationalityIssue);
type Values = z.infer<typeof schema>;

/**
 * Edit a student (update_student, version-checked). Only changed fields are sent. On CONFLICT the
 * profile is reloaded and the user is told to redo the change (the dialog re-opens with fresh data).
 */
export function StudentEditDialog({
  student,
  open,
  onOpenChange,
  onReload,
}: {
  student: StudentCore;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  const update = useUpdateStudent();
  const [error, setError] = useState<unknown>(null);
  const original: Values = { ...studentFieldsFrom(student), status: student.status };
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: original });
  const isIndian = useWatch({ control: form.control, name: 'is_indian_national' });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const before = { ...studentPayload(original), status: original.status };
    const after = { ...studentPayload(v), status: v.status };
    const p = changedFields(before, after);
    if (Object.keys(p).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ studentId: student.id, version: student.version, p });
      toast.success('Student record saved.');
      onOpenChange(false);
    } catch (e) {
      const err = handleSaveError(e, { reload: onReload, form });
      if (err?.code === 'CONFLICT') onOpenChange(false); // reopen to see the other person's change
      setError(err);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {student.full_name}</DialogTitle>
          <DialogDescription>
            Admission number {student.admission_no}. Sensitive identifiers are edited separately.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-6" noValidate>
            <StudentFieldsSections control={form.control} isIndian={isIndian} />
            <SelectField
              control={form.control}
              name="status"
              label="Record status"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <ErrorText error={error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
