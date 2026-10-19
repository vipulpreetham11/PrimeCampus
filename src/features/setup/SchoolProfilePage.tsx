import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from '@/lib/zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import type { SchoolProfile } from '@/contracts/setup';
import { blankToNull, changedFields, handleSaveError } from '@/lib/save-feedback';
import { useSaveSchoolProfile, useSchoolProfile } from './hooks';

// Field rules mirror app.schools CHECK constraints.
const optional = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || re.test(v), msg);

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the school name').max(200),
  udise_code: optional(/^[0-9]{11}$/, 'UDISE code is 11 digits'),
  board: z.string().trim().max(60),
  affiliation_no: z.string().trim().max(60),
  phone: optional(/^[0-9+ -]{6,20}$/, '6–20 digits, spaces, + or -'),
  email: optional(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email'),
  address_line: z.string().trim().max(500),
  city: z.string().trim().max(80),
  district: z.string().trim().max(80),
  pincode: optional(/^[0-9]{6}$/, 'Pincode is 6 digits'),
});
type Values = z.infer<typeof schema>;
const FIELDS = Object.keys(schema.shape) as (keyof Values)[];

function toValues(p: SchoolProfile): Values {
  return Object.fromEntries(FIELDS.map((k) => [k, (p[k] as string | null) ?? ''])) as Values;
}

function ProfileForm({ profile, onReload }: { profile: SchoolProfile; onReload: () => void }) {
  const save = useSaveSchoolProfile();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(profile) });
  const readOnly = !profile.can_edit;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const diff = changedFields(toValues(profile), values);
    if (Object.keys(diff).length === 0) {
      toast.info('Nothing to save.');
      return;
    }
    const p = Object.fromEntries(
      Object.entries(diff).map(([k, v]) => [k, k === 'name' ? (v as string) : blankToNull(v as string)]),
    );
    try {
      await save.mutateAsync({ p, version: profile.version });
      toast.success('School profile saved.');
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload, form }));
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <TextField
          control={form.control}
          name="name"
          label="School name"
          className="sm:col-span-2"
          disabled={readOnly}
        />
        <TextField
          control={form.control}
          name="udise_code"
          label="UDISE code"
          inputMode="numeric"
          disabled={readOnly}
        />
        <TextField control={form.control} name="board" label="Board" disabled={readOnly} />
        <TextField
          control={form.control}
          name="affiliation_no"
          label="Affiliation number"
          disabled={readOnly}
        />
        <TextField
          control={form.control}
          name="phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          disabled={readOnly}
        />
        <TextField control={form.control} name="email" label="Email" type="email" disabled={readOnly} />
        <TextField
          control={form.control}
          name="address_line"
          label="Address"
          className="sm:col-span-2"
          disabled={readOnly}
        />
        <TextField control={form.control} name="city" label="City" disabled={readOnly} />
        <TextField control={form.control} name="district" label="District" disabled={readOnly} />
        <TextField
          control={form.control}
          name="pincode"
          label="Pincode"
          inputMode="numeric"
          disabled={readOnly}
        />
        <div className="text-sm sm:self-end">
          <p className="text-muted-foreground">State</p>
          <p>{profile.state ?? '—'}</p>
        </div>
        <div className="space-y-3 sm:col-span-2">
          <ErrorText error={error} />
          {!readOnly && (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save profile'}
              </Button>
              {form.formState.isDirty && !save.isPending && (
                <span className="text-muted-foreground text-sm" role="status">
                  Unsaved changes
                </span>
              )}
            </div>
          )}
        </div>
      </form>
    </Form>
  );
}

export function SchoolProfilePage() {
  const query = useSchoolProfile();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">School profile</CardTitle>
        <CardDescription>
          School code <span className="font-mono">{query.data?.code ?? '…'}</span> is the username prefix and
          cannot be changed here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState query={query}>
          {/* keyed by version: a reload after CONFLICT or a successful save shows the server's values */}
          {(profile) => (
            <ProfileForm key={profile.version} profile={profile} onReload={() => void query.refetch()} />
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
