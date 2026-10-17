import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { DateField, SelectField, TextAreaField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { LEAD_SOURCES, type Lead } from '@/contracts/admissions';
import { blankToNull, changedFields, handleSaveError } from '@/lib/save-feedback';
import { useCurrentYearId } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { useSaveLead } from './hooks';

export const SOURCE_LABEL: Record<(typeof LEAD_SOURCES)[number], string> = {
  walk_in: 'Walk-in',
  website: 'Website',
  referral: 'Referral',
  phone: 'Phone call',
  other: 'Other',
};

const NO_CLASS = '__none__';
const opt = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || re.test(v), msg);

// Mirrors app.leads CHECK constraints.
const schema = z.object({
  parent_name: z.string().trim().min(1, 'Enter the parent’s name').max(200),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9]{10}$/, '10-digit mobile number'),
  alt_phone: opt(/^[0-9]{10}$/, '10-digit mobile number'),
  email: opt(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email'),
  child_name: z.string().trim().max(200),
  child_dob: z.string(),
  interested_class_id: z.string(),
  source: z.enum(LEAD_SOURCES),
  source_detail: z.string().trim().max(200),
  next_follow_up_on: z.string(),
  notes: z.string().trim().max(4000),
});
type Values = z.infer<typeof schema>;

function toPayload(v: Values) {
  return {
    parent_name: v.parent_name.trim(),
    phone: v.phone.trim(),
    alt_phone: blankToNull(v.alt_phone),
    email: blankToNull(v.email),
    child_name: blankToNull(v.child_name),
    child_dob: blankToNull(v.child_dob),
    interested_class_id: v.interested_class_id === NO_CLASS ? null : v.interested_class_id,
    source: v.source,
    source_detail: blankToNull(v.source_detail),
    next_follow_up_on: blankToNull(v.next_follow_up_on),
    notes: blankToNull(v.notes),
  };
}

function fromLead(l: Lead): Values {
  return {
    parent_name: l.parent_name,
    phone: l.phone,
    alt_phone: l.alt_phone ?? '',
    email: l.email ?? '',
    child_name: l.child_name ?? '',
    child_dob: l.child_dob ?? '',
    interested_class_id: l.interested_class_id ?? NO_CLASS,
    source: l.source,
    source_detail: l.source_detail ?? '',
    next_follow_up_on: l.next_follow_up_on ?? '',
    notes: l.notes ?? '',
  };
}

export function LeadFormDialog({
  lead,
  open,
  onOpenChange,
  onReload,
}: {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload?: () => void;
}) {
  const save = useSaveLead();
  const navigate = useNavigate();
  const yearId = useCurrentYearId();
  const snapshot = useSetupSnapshot(null);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: lead
      ? fromLead(lead)
      : {
          parent_name: '',
          phone: '',
          alt_phone: '',
          email: '',
          child_name: '',
          child_dob: '',
          interested_class_id: NO_CLASS,
          source: 'walk_in',
          source_detail: '',
          next_follow_up_on: '',
          notes: '',
        },
  });
  const classes = (snapshot.data?.classes ?? []).filter((c) => c.status === 'active');

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const payload = toPayload(v);
    const p = lead
      ? changedFields(toPayload(fromLead(lead)), payload)
      : { ...payload, ...(yearId ? { academic_year_id: yearId } : {}) };
    if (lead && Object.keys(p).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      const res = await save.mutateAsync({
        ...(lead ? { leadId: lead.id, version: lead.version } : {}),
        lead: p,
      });
      toast.success(lead ? 'Enquiry saved.' : 'Enquiry created.');
      if (res.possible_duplicates.length > 0) {
        toast.info(
          `${res.possible_duplicates.length} other enquir${res.possible_duplicates.length === 1 ? 'y has' : 'ies have'} the same phone (e.g. siblings). They are kept separate.`,
        );
      }
      onOpenChange(false);
      if (!lead) navigate(`/admissions/${res.lead_id}`);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload }));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{lead ? 'Edit enquiry' : 'New enquiry'}</DialogTitle>
          <DialogDescription>
            The same phone can have several enquiries (e.g. siblings); they are never merged.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
            <TextField control={form.control} name="parent_name" label="Parent’s name" />
            <TextField control={form.control} name="phone" label="Mobile" type="tel" inputMode="numeric" />
            <TextField
              control={form.control}
              name="alt_phone"
              label="Alternate mobile"
              type="tel"
              inputMode="numeric"
            />
            <TextField control={form.control} name="email" label="Email" type="email" />
            <TextField control={form.control} name="child_name" label="Child’s name" />
            <DateField control={form.control} name="child_dob" label="Child’s date of birth" />
            <SelectField
              control={form.control}
              name="interested_class_id"
              label="Class wanted"
              options={[
                { value: NO_CLASS, label: 'Not decided' },
                ...classes.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <SelectField
              control={form.control}
              name="source"
              label="How they found us"
              options={LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
            />
            <TextField control={form.control} name="source_detail" label="Source details" />
            <DateField control={form.control} name="next_follow_up_on" label="Next follow-up" />
            <TextAreaField control={form.control} name="notes" label="Notes" className="sm:col-span-2" />
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
      </DialogContent>
    </Dialog>
  );
}
