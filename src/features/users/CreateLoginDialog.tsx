import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { X } from 'lucide-react';
import { ErrorText } from '@/components/shared/ErrorText';
import { SelectField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { roleLabel, type Role } from '@/contracts/roles';
import type { GuardianSearchItem } from '@/contracts/students';
import { DUTY_ROLES, GRANTABLE_ROLES } from '@/contracts/users';
import { isAppError } from '@/lib/errors';
import { useOperationId } from '@/lib/operation';
import { useSessionSelector } from '@/lib/session/store';
import { GuardianPicker } from '@/features/students/GuardianPicker';
import { useStaffList } from '@/features/staff/hooks';
import { provisionLogin, useRefreshAfterLoginChange, type IssuedPassword } from './hooks';

const STAFF_ROLES: readonly string[] = ['owner', 'admin', 'principal', 'accountant', 'teacher'];
const NO_STAFF = '__none__';

const schema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,62}$/, '3–63 characters: a–z, 0–9, dot, dash or underscore'),
  display_name: z.string().trim().min(1, 'Enter the person’s name').max(200),
  roles: z.array(z.enum(GRANTABLE_ROLES)).min(1, 'Choose at least one role'),
  admissions_duty: z.boolean(),
  staff_id: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * Create a login (Edge `provision`). One operation id per dialog: a retry after a lost response
 * reuses it (the server resumes instead of creating a second identity); it is renewed only after
 * success or a definite refusal. The temporary password goes straight to `onIssued` and is never
 * cached or logged.
 */
export function CreateLoginDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onIssued: (p: IssuedPassword) => void;
}) {
  const schoolId = useSessionSelector((s) => s.context?.school_id ?? '');
  const { operationId, reset } = useOperationId();
  const refresh = useRefreshAfterLoginChange();
  const staff = useStaffList(null, false);
  const [guardians, setGuardians] = useState<GuardianSearchItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', display_name: '', roles: [], admissions_duty: false, staff_id: NO_STAFF },
  });
  const roles = useWatch({ control: form.control, name: 'roles' });
  const duty = useWatch({ control: form.control, name: 'admissions_duty' });
  const needsStaff = roles.some((r) => STAFF_ROLES.includes(r));
  const isParent = roles.includes('parent');
  const dutyAllowed = roles.some((r) => (DUTY_ROLES as readonly string[]).includes(r));

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const memberships = v.roles.map((role) => ({
        school_id: schoolId,
        role: role as Exclude<Role, 'operator'>,
        ...(v.admissions_duty && (DUTY_ROLES as readonly string[]).includes(role)
          ? { admissions_duty: true }
          : {}),
      }));
      const links = {
        ...(needsStaff && v.staff_id !== NO_STAFF ? { staff_id: v.staff_id } : {}),
        ...(isParent && guardians.length > 0 ? { guardian_ids: guardians.map((g) => g.guardian_id) } : {}),
      };
      const issued = await provisionLogin({
        operationId,
        username: v.username,
        displayName: v.display_name,
        memberships,
        links,
      });
      reset();
      refresh();
      if (issued) {
        form.reset();
        setGuardians([]);
        onOpenChange(false);
        onIssued(issued);
      } else {
        setNote(
          'This login was already created by an earlier attempt. Use “Reset password” if they need a new one.',
        );
      }
    } catch (e) {
      // A definite refusal ends this attempt; a network failure keeps the id so a retry resumes.
      if (isAppError(e) && e.code !== 'NETWORK' && e.code !== 'TEMPORARILY_UNAVAILABLE') reset();
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create login</DialogTitle>
          <DialogDescription>
            A temporary password is shown once. The person must change it at first sign-in. No email or SMS is
            sent.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField
              control={form.control}
              name="username"
              label="Username"
              autoComplete="off"
              description="Usernames are unique across all schools — start with the school code (e.g. demo.teacher)."
            />
            <TextField control={form.control} name="display_name" label="Full name" />
            <FormField
              control={form.control}
              name="roles"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Roles in this school</FormLabel>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {GRANTABLE_ROLES.map((r) => (
                      <label key={r} className="flex items-center gap-2 text-sm">
                        <FormControl>
                          <Checkbox
                            checked={field.value.includes(r)}
                            onCheckedChange={(c) =>
                              field.onChange(
                                c === true ? [...field.value, r] : field.value.filter((x) => x !== r),
                              )
                            }
                          />
                        </FormControl>
                        {roleLabel(r)}
                      </label>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            {dutyAllowed && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={duty}
                  onCheckedChange={(c) => form.setValue('admissions_duty', c === true)}
                />
                Admissions duty (may manage enquiries and admissions)
              </label>
            )}
            {needsStaff && (
              <SelectField
                control={form.control}
                name="staff_id"
                label="Link to staff record (optional)"
                options={[
                  { value: NO_STAFF, label: 'Don’t link now' },
                  ...(staff.data ?? [])
                    .filter((s) => !s.has_login)
                    .map((s) => ({ value: s.staff_id, label: `${s.name} (${s.employee_no})` })),
                ]}
              />
            )}
            {isParent && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Link to guardian record(s)</p>
                {guardians.length > 0 && (
                  <ul className="space-y-1">
                    {guardians.map((g) => (
                      <li
                        key={g.guardian_id}
                        className="bg-muted/50 flex items-center justify-between rounded px-2 py-1 text-sm"
                      >
                        <span>
                          {g.full_name}
                          {g.children.length > 0 && (
                            <span className="text-muted-foreground">
                              {' '}
                              — {g.children.map((c) => c.name).join(', ')}
                            </span>
                          )}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${g.full_name}`}
                          onClick={() =>
                            setGuardians((gs) => gs.filter((x) => x.guardian_id !== g.guardian_id))
                          }
                        >
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <GuardianPicker
                  label="Find the guardian"
                  excludeIds={guardians.map((g) => g.guardian_id)}
                  onPick={(g) => setGuardians((gs) => [...gs, g])}
                />
                <p className="text-muted-foreground text-xs">
                  The parent sees only children linked to these guardian records with portal access.
                </p>
              </div>
            )}
            {note && (
              <p role="status" className="text-sm">
                {note}
              </p>
            )}
            <ErrorText error={error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create login'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
