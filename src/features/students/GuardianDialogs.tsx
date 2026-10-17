import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { SelectField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  RELATIONSHIPS,
  type GuardianRecord,
  type GuardianSearchItem,
  type ProfileGuardian,
} from '@/contracts/students';
import { blankToNull, changedFields, handleSaveError } from '@/lib/save-feedback';
import { LinkLoginCard } from '@/features/users/LinkLoginCard';
import { GuardianPicker } from './GuardianPicker';
import { useGuardian, useSaveGuardian, type GuardianFields } from './hooks';

export const RELATIONSHIP_LABEL: Record<(typeof RELATIONSHIPS)[number], string> = {
  mother: 'Mother',
  father: 'Father',
  guardian: 'Guardian',
  grandparent: 'Grandparent',
  sibling: 'Sibling',
  other: 'Other',
};

// Mirrors app.guardians CHECK constraints.
const opt = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || re.test(v), msg);
export const guardianShape = {
  full_name: z.string().trim().min(1, 'Enter the name').max(200),
  phone: opt(/^[0-9]{10}$/, '10-digit mobile number'),
  alt_phone: opt(/^[0-9]{10}$/, '10-digit mobile number'),
  email: opt(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email'),
  occupation: z.string().trim().max(100),
  address_line: z.string().trim().max(500),
};
const editSchema = z.object({ ...guardianShape, status: z.enum(['active', 'inactive']) });
type EditValues = z.infer<typeof editSchema>;

function toFields(v: Omit<EditValues, 'status'> & { status?: 'active' | 'inactive' }): GuardianFields {
  return {
    full_name: v.full_name.trim(),
    phone: blankToNull(v.phone),
    alt_phone: blankToNull(v.alt_phone),
    email: blankToNull(v.email),
    occupation: blankToNull(v.occupation),
    address_line: blankToNull(v.address_line),
    ...(v.status ? { status: v.status } : {}),
  };
}

function GuardianEditForm({
  g,
  onDone,
  onReload,
}: {
  g: GuardianRecord;
  onDone: () => void;
  onReload: () => void;
}) {
  const save = useSaveGuardian();
  const [error, setError] = useState<unknown>(null);
  const original: EditValues = {
    full_name: g.full_name,
    phone: g.phone ?? '',
    alt_phone: g.alt_phone ?? '',
    email: g.email ?? '',
    occupation: g.occupation ?? '',
    address_line: g.address_line ?? '',
    status: g.status,
  };
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema), defaultValues: original });
  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={form.handleSubmit(async (v) => {
          setError(null);
          const p = changedFields(toFields(original), toFields(v));
          if (Object.keys(p).length === 0) return onDone();
          try {
            const res = await save.mutateAsync({ guardianId: g.guardian_id, version: g.version, p });
            toast.success('Guardian saved.');
            if (res.same_phone_guardians.length > 0) {
              toast.info(
                `Another guardian has the same phone: ${res.same_phone_guardians.map((x) => x.full_name).join(', ')}. They are kept as separate people.`,
              );
            }
            onDone();
          } catch (e) {
            setError(handleSaveError(e, { reload: onReload }));
          }
        })}
      >
        <TextField control={form.control} name="full_name" label="Full name" className="sm:col-span-2" />
        <TextField control={form.control} name="phone" label="Mobile" type="tel" inputMode="numeric" />
        <TextField
          control={form.control}
          name="alt_phone"
          label="Alternate mobile"
          type="tel"
          inputMode="numeric"
        />
        <TextField control={form.control} name="email" label="Email" type="email" />
        <TextField control={form.control} name="occupation" label="Occupation" />
        <TextField control={form.control} name="address_line" label="Address" className="sm:col-span-2" />
        <SelectField
          control={form.control}
          name="status"
          label="Status"
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        <div className="space-y-3 sm:col-span-2">
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save guardian'}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

/** Guardian record: edit (version-checked via get_guardian) + linked login + children. */
export function GuardianEditDialog({
  guardianId,
  open,
  onOpenChange,
}: {
  guardianId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const query = useGuardian(guardianId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Guardian</DialogTitle>
          <DialogDescription>Changes apply to every child this person is linked to.</DialogDescription>
        </DialogHeader>
        <DataState query={query}>
          {(g) => (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Linked to:{' '}
                {g.children.map((c) => `${c.name} (${RELATIONSHIP_LABEL[c.relationship]})`).join(', ') ||
                  'no children'}
              </p>
              {g.can.edit ? (
                <GuardianEditForm
                  key={g.version}
                  g={g}
                  onDone={() => onOpenChange(false)}
                  onReload={() => void query.refetch()}
                />
              ) : (
                <p className="text-sm">{g.full_name}</p>
              )}
              {g.can.link_login && <LinkLoginCard kind="guardian" recordId={g.guardian_id} login={g.login} />}
            </div>
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}

function LinkFields({
  relationship,
  setRelationship,
  isPrimary,
  setIsPrimary,
  portal,
  setPortal,
}: {
  relationship: string;
  setRelationship: (v: string) => void;
  isPrimary: boolean;
  setIsPrimary: (v: boolean) => void;
  portal: boolean;
  setPortal: (v: boolean) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <div className="space-y-1">
        <Label htmlFor="gl-rel">Relationship</Label>
        <Select value={relationship} onValueChange={setRelationship}>
          <SelectTrigger id="gl-rel" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RELATIONSHIPS.map((r) => (
              <SelectItem key={r} value={r}>
                {RELATIONSHIP_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} /> Primary contact
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={portal} onCheckedChange={(v) => setPortal(v === true)} /> Can see this child when
        signed in
      </label>
    </div>
  );
}

/** Change relationship / primary / portal access of an existing link (save_guardian with p = {}). */
export function GuardianLinkDialog({
  studentId,
  link,
  open,
  onOpenChange,
}: {
  studentId: string;
  link: ProfileGuardian;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveGuardian();
  const [relationship, setRelationship] = useState<string>(link.relationship);
  const [isPrimary, setIsPrimary] = useState(link.is_primary);
  const [portal, setPortal] = useState(link.portal_access);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{link.name} — link to this student</DialogTitle>
          <DialogDescription>
            Making someone primary removes primary from the other guardians of this student.
          </DialogDescription>
        </DialogHeader>
        <LinkFields {...{ relationship, setRelationship, isPrimary, setIsPrimary, portal, setPortal }} />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={async () => {
              setError(null);
              try {
                await save.mutateAsync({
                  guardianId: link.guardian_id,
                  p: {},
                  link: { studentId, relationship, isPrimary, portalAccess: portal },
                });
                toast.success('Saved.');
                onOpenChange(false);
              } catch (e) {
                setError(handleSaveError(e));
              }
            }}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const newSchema = z.object(guardianShape);
type NewValues = z.infer<typeof newSchema>;

/** Add a guardian to a student: pick an existing one (siblings) or create a new person. */
export function AddGuardianDialog({
  studentId,
  existingIds,
  open,
  onOpenChange,
}: {
  studentId: string;
  existingIds: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveGuardian();
  const [picked, setPicked] = useState<GuardianSearchItem | null>(null);
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [relationship, setRelationship] = useState<string>('guardian');
  const [isPrimary, setIsPrimary] = useState(existingIds.length === 0);
  const [portal, setPortal] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<NewValues>({
    resolver: zodResolver(newSchema),
    defaultValues: { full_name: '', phone: '', alt_phone: '', email: '', occupation: '', address_line: '' },
  });
  const link = { studentId, relationship, isPrimary, portalAccess: portal };

  const submit = async (p: Partial<GuardianFields>, guardianId?: string) => {
    setError(null);
    try {
      const res = await save.mutateAsync({ ...(guardianId ? { guardianId } : {}), p, link });
      toast.success('Guardian linked.');
      if (res.same_phone_guardians.length > 0) {
        toast.info(
          `Same phone as: ${res.same_phone_guardians.map((x) => x.full_name).join(', ')}. Kept as separate people — link the existing one instead if it is the same person.`,
        );
      }
      onOpenChange(false);
    } catch (e) {
      setError(handleSaveError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add parent / guardian</DialogTitle>
          <DialogDescription>
            Search first — brothers and sisters should share the same guardian record.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'find' ? 'default' : 'outline'} onClick={() => setMode('find')}>
            Existing guardian
          </Button>
          <Button size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>
            New person
          </Button>
        </div>
        {mode === 'find' ? (
          picked ? (
            <div className="flex items-center justify-between rounded-md border p-2 text-sm">
              <span>
                <span className="font-medium">{picked.full_name}</span>
                {picked.phone ? ` · ${picked.phone}` : ''}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>
          ) : (
            <GuardianPicker excludeIds={existingIds} onPick={setPicked} />
          )
        ) : (
          <Form {...form}>
            <form
              id="new-guardian"
              noValidate
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={form.handleSubmit((v) => submit(toFields(v)))}
            >
              <TextField
                control={form.control}
                name="full_name"
                label="Full name"
                className="sm:col-span-2"
              />
              <TextField control={form.control} name="phone" label="Mobile" type="tel" inputMode="numeric" />
              <TextField
                control={form.control}
                name="alt_phone"
                label="Alternate mobile"
                type="tel"
                inputMode="numeric"
              />
              <TextField control={form.control} name="email" label="Email" type="email" />
              <TextField control={form.control} name="occupation" label="Occupation" />
              <TextField
                control={form.control}
                name="address_line"
                label="Address"
                className="sm:col-span-2"
              />
            </form>
          </Form>
        )}
        <LinkFields {...{ relationship, setRelationship, isPrimary, setIsPrimary, portal, setPortal }} />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {mode === 'find' ? (
            <Button
              disabled={!picked || save.isPending}
              onClick={() => picked && void submit({}, picked.guardian_id)}
            >
              {save.isPending ? 'Linking…' : 'Link guardian'}
            </Button>
          ) : (
            <Button type="submit" form="new-guardian" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Create and link'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
