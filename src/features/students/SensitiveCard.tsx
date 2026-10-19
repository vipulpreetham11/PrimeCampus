import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from '@/lib/zod';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { MoneyField, SelectField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import {
  MAINSTREAMED_IN,
  MINORITY_GROUPS,
  SOCIAL_CATEGORIES,
  type StudentSensitive,
} from '@/contracts/students';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSaveSensitive } from './hooks';

// Reporting-sensitive identifiers (brief §4.3). Rendered only with students.sensitive. Values are
// never logged, never put in telemetry (paths are id-stripped) and never in a URL.
// save_student_sensitive replaces the whole row, so the form always sends every field.

const UNSET = 'unset';
const triOptions = [
  { value: UNSET, label: 'Not recorded' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];
const tri = (v: boolean | null) => (v === null ? UNSET : v ? 'yes' : 'no');
const fromTri = (v: string) => (v === UNSET ? null : v === 'yes');
const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const schema = z
  .object({
    name_as_per_aadhaar: z.string().trim().max(200),
    aadhaar_number: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[0-9]{12}$/.test(v), 'Aadhaar is 12 digits'),
    student_national_code: z.string().trim().max(30),
    apaar_id: z.string().trim().max(30),
    social_category: z.string(),
    minority_group: z.string(),
    is_bpl: z.string(),
    is_aay: z.string(),
    is_ews_disadvantaged: z.string(),
    is_cwsn: z.string(),
    impairment_type: z.string().trim().max(60),
    has_disability_cert: z.string(),
    disability_percent: z
      .string()
      .trim()
      .refine((v) => v === '' || (/^\d{1,3}$/.test(v) && Number(v) <= 100), '0–100'),
    is_out_of_school_child: z.string(),
    mainstreamed_in: z.string(),
    family_annual_income_paise: z.number().nullable(),
  })
  // CHECK constraints on app.student_sensitive
  .refine((v) => v.is_aay !== 'yes' || v.is_bpl === 'yes', {
    path: ['is_aay'],
    message: 'AAY needs BPL = Yes',
  })
  .refine((v) => v.is_cwsn === 'yes' || (v.impairment_type === '' && v.disability_percent === ''), {
    path: ['is_cwsn'],
    message: 'Impairment details need CWSN = Yes',
  })
  .refine((v) => v.is_out_of_school_child === 'yes' || v.mainstreamed_in === UNSET, {
    path: ['mainstreamed_in'],
    message: 'Only for out-of-school children',
  });
type Values = z.infer<typeof schema>;

function toValues(s: StudentSensitive | null): Values {
  return {
    name_as_per_aadhaar: s?.name_as_per_aadhaar ?? '',
    aadhaar_number: s?.aadhaar_number ?? '',
    student_national_code: s?.student_national_code ?? '',
    apaar_id: s?.apaar_id ?? '',
    social_category: s?.social_category ?? UNSET,
    minority_group: s?.minority_group ?? UNSET,
    is_bpl: tri(s?.is_bpl ?? null),
    is_aay: tri(s?.is_aay ?? null),
    is_ews_disadvantaged: tri(s?.is_ews_disadvantaged ?? null),
    is_cwsn: tri(s?.is_cwsn ?? null),
    impairment_type: s?.impairment_type ?? '',
    has_disability_cert: tri(s?.has_disability_cert ?? null),
    disability_percent:
      s?.disability_percent === null || s?.disability_percent === undefined
        ? ''
        : String(s.disability_percent),
    is_out_of_school_child: tri(s?.is_out_of_school_child ?? null),
    mainstreamed_in: s?.mainstreamed_in ?? UNSET,
    family_annual_income_paise: s?.family_annual_income_paise ?? null,
  };
}

function toPayload(v: Values) {
  const t = (x: string) => (x.trim() === '' ? null : x.trim());
  const e = (x: string) => (x === UNSET ? null : x);
  return {
    name_as_per_aadhaar: t(v.name_as_per_aadhaar),
    aadhaar_number: t(v.aadhaar_number),
    student_national_code: t(v.student_national_code),
    apaar_id: t(v.apaar_id),
    social_category: e(v.social_category),
    minority_group: e(v.minority_group),
    is_bpl: fromTri(v.is_bpl),
    is_aay: fromTri(v.is_aay),
    is_ews_disadvantaged: fromTri(v.is_ews_disadvantaged),
    is_cwsn: fromTri(v.is_cwsn),
    impairment_type: t(v.impairment_type),
    has_disability_cert: fromTri(v.has_disability_cert),
    disability_percent: v.disability_percent === '' ? null : Number(v.disability_percent),
    is_out_of_school_child: fromTri(v.is_out_of_school_child),
    mainstreamed_in: e(v.mainstreamed_in),
    family_annual_income_paise: v.family_annual_income_paise,
  };
}

function SensitiveForm({
  studentId,
  current,
  onDone,
}: {
  studentId: string;
  current: StudentSensitive | null;
  onDone: () => void;
}) {
  const save = useSaveSensitive();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(current) });
  const cwsn = useWatch({ control: form.control, name: 'is_cwsn' });
  const outOfSchool = useWatch({ control: form.control, name: 'is_out_of_school_child' });
  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={form.handleSubmit(async (v) => {
          setError(null);
          try {
            await save.mutateAsync({ studentId, p: toPayload(v) });
            toast.success('Sensitive details saved.');
            onDone();
          } catch (e) {
            setError(
              handleSaveError(e, { form, fields: { family_annual_income: 'family_annual_income_paise' } }),
            );
          }
        })}
      >
        <TextField control={form.control} name="name_as_per_aadhaar" label="Name as per Aadhaar" />
        <TextField
          control={form.control}
          name="aadhaar_number"
          label="Aadhaar number"
          inputMode="numeric"
          autoComplete="off"
        />
        <TextField control={form.control} name="student_national_code" label="PEN (entered, not generated)" />
        <TextField control={form.control} name="apaar_id" label="APAAR ID (entered, not generated)" />
        <SelectField
          control={form.control}
          name="social_category"
          label="Social category"
          options={[
            { value: UNSET, label: 'Not recorded' },
            ...SOCIAL_CATEGORIES.map((c) => ({ value: c, label: c.toUpperCase() })),
          ]}
        />
        <SelectField
          control={form.control}
          name="minority_group"
          label="Minority group"
          options={[
            { value: UNSET, label: 'Not recorded' },
            ...MINORITY_GROUPS.map((c) => ({ value: c, label: label(c) })),
          ]}
        />
        <SelectField control={form.control} name="is_bpl" label="BPL" options={triOptions} />
        <SelectField control={form.control} name="is_aay" label="AAY (Antyodaya)" options={triOptions} />
        <SelectField
          control={form.control}
          name="is_ews_disadvantaged"
          label="EWS / disadvantaged"
          options={triOptions}
        />
        <SelectField control={form.control} name="is_cwsn" label="CWSN" options={triOptions} />
        {cwsn === 'yes' && (
          <>
            <TextField control={form.control} name="impairment_type" label="Impairment type" />
            <SelectField
              control={form.control}
              name="has_disability_cert"
              label="Disability certificate"
              options={triOptions}
            />
            <TextField
              control={form.control}
              name="disability_percent"
              label="Disability %"
              inputMode="numeric"
            />
          </>
        )}
        <SelectField
          control={form.control}
          name="is_out_of_school_child"
          label="Out-of-school child"
          options={triOptions}
        />
        {outOfSchool === 'yes' && (
          <SelectField
            control={form.control}
            name="mainstreamed_in"
            label="Mainstreamed in"
            options={[
              { value: UNSET, label: 'Not recorded' },
              ...MAINSTREAMED_IN.map((c) => ({ value: c, label: label(c) })),
            ]}
          />
        )}
        <MoneyField control={form.control} name="family_annual_income_paise" label="Family annual income" />
        <div className="space-y-3 sm:col-span-2">
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

export function SensitiveCard({
  studentId,
  sensitive,
}: {
  studentId: string;
  sensitive: StudentSensitive | null;
}) {
  const canSee = useCan('students.sensitive');
  const [editing, setEditing] = useState(false);
  if (!canSee) return null;
  const s = sensitive;
  const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? 'Yes' : 'No');
  return (
    <Card data-testid="sensitive-card">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Sensitive identifiers</CardTitle>
          <CardDescription>
            Admin only. Used for UDISE+ style reporting; never shown to teachers or parents.
          </CardDescription>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {s ? 'Edit' : 'Add'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="text-sm">
        {editing ? (
          <SensitiveForm studentId={studentId} current={s} onDone={() => setEditing(false)} />
        ) : !s ? (
          <p className="text-muted-foreground">Nothing recorded.</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted-foreground">Name as per Aadhaar</dt>
            <dd>{s.name_as_per_aadhaar ?? '—'}</dd>
            <dt className="text-muted-foreground">Aadhaar</dt>
            <dd className="font-mono">
              {s.aadhaar_number ? `•••• •••• ${s.aadhaar_number.slice(-4)}` : '—'}
            </dd>
            <dt className="text-muted-foreground">PEN / APAAR</dt>
            <dd>
              {s.student_national_code ?? '—'} / {s.apaar_id ?? '—'}
            </dd>
            <dt className="text-muted-foreground">Social category</dt>
            <dd>{s.social_category?.toUpperCase() ?? '—'}</dd>
            <dt className="text-muted-foreground">Minority group</dt>
            <dd>{s.minority_group ? label(s.minority_group) : '—'}</dd>
            <dt className="text-muted-foreground">BPL / AAY / EWS</dt>
            <dd>
              {yn(s.is_bpl)} / {yn(s.is_aay)} / {yn(s.is_ews_disadvantaged)}
            </dd>
            <dt className="text-muted-foreground">CWSN</dt>
            <dd>
              {yn(s.is_cwsn)}
              {s.is_cwsn
                ? ` — ${s.impairment_type ?? 'type not recorded'}${s.disability_percent !== null ? `, ${s.disability_percent}%` : ''}`
                : ''}
            </dd>
            <dt className="text-muted-foreground">Out-of-school child</dt>
            <dd>{yn(s.is_out_of_school_child)}</dd>
            <dt className="text-muted-foreground">Family annual income</dt>
            <dd>
              <MoneyText paise={s.family_annual_income_paise} />
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
