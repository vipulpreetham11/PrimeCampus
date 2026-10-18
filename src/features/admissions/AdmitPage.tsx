import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { DateField, SelectField, TextField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Form } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LeadDetail } from '@/contracts/admissions';
import type { SetupSnapshot } from '@/contracts/setup';
import { RELATIONSHIPS, SOCIAL_CATEGORIES, type GuardianSearchItem } from '@/contracts/students';
import { compareIsoDates, schoolToday } from '@/lib/dates';
import { useOperationTracker } from '@/lib/operation';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { GuardianPicker } from '@/features/students/GuardianPicker';
import { RELATIONSHIP_LABEL } from '@/features/students/GuardianDialogs';
import {
  StudentFieldsSections,
  emptyStudentFields,
  nationalityIssue,
  nationalityRule,
  studentFieldsShape,
  studentPayload,
} from '@/features/students/student-fields';
import { useAdmitStudent, useLead } from './hooks';

const UNSET = 'unset';

interface GuardianEntry {
  key: string;
  existing: GuardianSearchItem | null;
  full_name: string;
  phone: string;
  relationship: string;
  is_primary: boolean;
  portal_access: boolean;
}

function newGuardian(partial: Partial<GuardianEntry> = {}): GuardianEntry {
  return {
    key: crypto.randomUUID(),
    existing: null,
    full_name: '',
    phone: '',
    relationship: 'mother',
    is_primary: false,
    portal_access: true,
    ...partial,
  };
}

function guardianProblems(list: GuardianEntry[]): string[] {
  const out: string[] = [];
  if (list.length === 0) out.push('Link at least one parent or guardian.');
  list.forEach((g, i) => {
    if (!g.existing) {
      if (!g.full_name.trim()) out.push(`Guardian ${i + 1}: enter the name.`);
      if (g.phone.trim() && !/^[0-9]{10}$/.test(g.phone.trim()))
        out.push(`Guardian ${i + 1}: mobile must be 10 digits.`);
    }
  });
  if (list.filter((g) => g.is_primary).length > 1) out.push('Only one guardian can be primary.');
  return out;
}

function AdmitForm({ snapshot, lead }: { snapshot: SetupSnapshot; lead: LeadDetail | null }) {
  const navigate = useNavigate();
  const admit = useAdmitStudent();
  const canSensitive = useCan('students.sensitive');
  const operation = useOperationTracker(); // one id per admission; kept for an identical retry
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const year = snapshot.academic_years.find((y) => y.id === snapshot.selected_year_id);
  const today = schoolToday();
  const classes = new Map(snapshot.classes.map((c) => [c.id, c]));
  const sections = snapshot.sections
    .filter((s) => s.status === 'active')
    .sort((a, b) => (classes.get(a.class_id)?.sort_order ?? 0) - (classes.get(b.class_id)?.sort_order ?? 0));
  const wanted = lead?.lead.interested_class_id;

  const schema = z
    .object({
      ...studentFieldsShape,
      admission_no: z.string().trim().min(1, 'Enter the admission number').max(40),
      section_id: z.string().min(1, 'Choose a section'),
      joined_on: z
        .string()
        .min(1, 'Choose the joining date')
        .refine(
          (d) =>
            !year ||
            !d ||
            (compareIsoDates(d, year.start_date) >= 0 && compareIsoDates(d, year.end_date) <= 0),
          `Must be inside ${year?.name ?? 'the academic year'}`,
        ),
      roll_no: z
        .string()
        .trim()
        .refine((v) => v === '' || /^[A-Za-z0-9/-]{1,12}$/.test(v), 'Up to 12 letters, digits, / or -'),
      aadhaar_number: z
        .string()
        .trim()
        .refine((v) => v === '' || /^[0-9]{12}$/.test(v), 'Aadhaar is 12 digits'),
      student_national_code: z.string().trim().max(30),
      apaar_id: z.string().trim().max(30),
      social_category: z.string(),
    })
    .refine(nationalityRule, nationalityIssue);
  type Values = z.infer<typeof schema>;

  const defaultYearToday =
    year && compareIsoDates(today, year.start_date) >= 0 && compareIsoDates(today, year.end_date) <= 0;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...emptyStudentFields(),
      full_name: lead?.lead.child_name ?? '',
      date_of_birth: lead?.lead.child_dob ?? '',
      admission_no: '',
      section_id: (wanted && sections.find((s) => s.class_id === wanted)?.id) || '',
      joined_on: defaultYearToday ? today : (year?.start_date ?? today),
      roll_no: '',
      aadhaar_number: '',
      student_national_code: '',
      apaar_id: '',
      social_category: UNSET,
    },
  });
  const isIndian = useWatch({ control: form.control, name: 'is_indian_national' });
  const [guardians, setGuardians] = useState<GuardianEntry[]>(() =>
    lead ? [newGuardian({ full_name: lead.lead.parent_name, phone: lead.lead.phone, is_primary: true })] : [],
  );
  const gProblems = guardianProblems(guardians);
  const update = (key: string, patch: Partial<GuardianEntry>) =>
    setGuardians((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  const onSubmit = form.handleSubmit(
    async (v) => {
      setTouched(true);
      if (gProblems.length > 0) return;
      setError(null);
      const sensitive = canSensitive
        ? Object.fromEntries(
            Object.entries({
              aadhaar_number: v.aadhaar_number.trim() || null,
              student_national_code: v.student_national_code.trim() || null,
              apaar_id: v.apaar_id.trim() || null,
              social_category: v.social_category === UNSET ? null : v.social_category,
            }).filter(([, x]) => x !== null),
          )
        : {};
      const payload = {
        leadId: lead?.lead.id ?? null,
        student: { ...studentPayload(v), admission_no: v.admission_no.trim() },
        guardians: guardians.map((g) => ({
          ...(g.existing
            ? { guardian_id: g.existing.guardian_id }
            : { full_name: g.full_name.trim(), ...(g.phone.trim() ? { phone: g.phone.trim() } : {}) }),
          relationship: g.relationship,
          is_primary: g.is_primary,
          portal_access: g.portal_access,
        })),
        sectionId: v.section_id,
        joinedOn: v.joined_on,
        rollNo: v.roll_no.trim() || null,
        sensitive: Object.keys(sensitive).length > 0 ? sensitive : null,
      };
      // Same id for an identical retry after an uncertain failure (cannot admit twice); new id if edited.
      const operationId = operation.idFor(payload);
      try {
        const res = await admit.mutateAsync({ operationId, ...payload });
        operation.succeeded();
        toast.success(
          'replayed' in res && res.replayed ? 'This enquiry was already admitted.' : 'Student admitted.',
        );
        navigate(`/students/${res.student_id}`, { replace: true });
      } catch (e) {
        operation.failed(e);
        setError(handleSaveError(e));
      }
    },
    () => setTouched(true),
  );

  if (!year) {
    return (
      <p className="rounded-md border border-dashed p-6 text-sm">
        Set a current academic year in School setup first.
      </p>
    );
  }
  if (sections.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-sm">Create sections for {year.name} first.</p>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Admission</CardTitle>
            <CardDescription>Joining date sets when attendance and fees start ({year.name}).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <TextField control={form.control} name="admission_no" label="Admission number" />
            <SelectField
              control={form.control}
              name="section_id"
              label="Class and section"
              options={sections.map((s) => ({
                value: s.id,
                label: `${classes.get(s.class_id)?.name ?? ''} ${s.name}`,
              }))}
            />
            <DateField
              control={form.control}
              name="joined_on"
              label="Joining date"
              min={year.start_date}
              max={year.end_date}
            />
            <TextField control={form.control} name="roll_no" label="Roll number (optional)" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Student details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <StudentFieldsSections control={form.control} isIndian={isIndian} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parents &amp; guardians</CardTitle>
            <CardDescription>Search first so brothers and sisters share the same guardian.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {guardians.map((g, i) => (
              <div
                key={g.key}
                className="space-y-3 rounded-md border p-3"
                data-testid={`admit-guardian-${i}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {g.existing ? `${g.existing.full_name} (existing)` : `New guardian ${i + 1}`}
                  </p>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove guardian ${i + 1}`}
                    onClick={() => setGuardians((gs) => gs.filter((x) => x.key !== g.key))}
                  >
                    <X />
                  </Button>
                </div>
                {!g.existing && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor={`g-${g.key}-name`}>Full name</Label>
                      <Input
                        id={`g-${g.key}-name`}
                        value={g.full_name}
                        onChange={(e) => update(g.key, { full_name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`g-${g.key}-phone`}>Mobile</Label>
                      <Input
                        id={`g-${g.key}-phone`}
                        inputMode="numeric"
                        value={g.phone}
                        onChange={(e) => update(g.key, { phone: e.target.value })}
                      />
                    </div>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
                  <div className="space-y-1">
                    <Label htmlFor={`g-${g.key}-rel`}>Relationship</Label>
                    <Select value={g.relationship} onValueChange={(v) => update(g.key, { relationship: v })}>
                      <SelectTrigger id={`g-${g.key}-rel`} className="w-full">
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
                    <Checkbox
                      checked={g.is_primary}
                      onCheckedChange={(v) => update(g.key, { is_primary: v === true })}
                    />{' '}
                    Primary
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={g.portal_access}
                      onCheckedChange={(v) => update(g.key, { portal_access: v === true })}
                    />{' '}
                    Can see this child when signed in
                  </label>
                </div>
              </div>
            ))}
            <GuardianPicker
              label="Add an existing parent / guardian"
              excludeIds={guardians.flatMap((g) => (g.existing ? [g.existing.guardian_id] : []))}
              onPick={(gp) =>
                setGuardians((gs) => [
                  ...gs,
                  newGuardian({ existing: gp, relationship: 'guardian', is_primary: gs.length === 0 }),
                ])
              }
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGuardians((gs) => [...gs, newGuardian({ is_primary: gs.length === 0 })])}
            >
              Add a new parent / guardian
            </Button>
            {touched && gProblems.length > 0 && (
              <ul role="alert" className="text-destructive list-inside list-disc text-sm">
                {gProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {canSensitive && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sensitive identifiers (optional)</CardTitle>
              <CardDescription>
                Admin only. More fields can be added later on the student profile.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="aadhaar_number"
                label="Aadhaar number"
                inputMode="numeric"
              />
              <TextField control={form.control} name="student_national_code" label="PEN" />
              <TextField control={form.control} name="apaar_id" label="APAAR ID" />
              <SelectField
                control={form.control}
                name="social_category"
                label="Social category"
                options={[
                  { value: UNSET, label: 'Not recorded' },
                  ...SOCIAL_CATEGORIES.map((c) => ({ value: c, label: c.toUpperCase() })),
                ]}
              />
            </CardContent>
          </Card>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" asChild>
            <Link to={lead ? `/admissions/${lead.lead.id}` : '/admissions'}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={admit.isPending}>
            {admit.isPending ? 'Admitting…' : 'Admit student'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

export function AdmitPage() {
  const [params] = useSearchParams();
  const leadId = params.get('lead') ?? undefined;
  const lead = useLead(leadId);
  const snapshot = useSetupSnapshot(null);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Admit a student"
        description={
          leadId
            ? 'From an enquiry: details are prefilled where known.'
            : 'Direct admission without an enquiry.'
        }
      />
      <DataState query={snapshot}>
        {(snap) =>
          leadId ? (
            <DataState query={lead}>
              {(d) =>
                d.lead.stage === 'converted' ? (
                  <p className="rounded-md border p-4 text-sm">
                    This enquiry was already admitted.{' '}
                    {d.lead.converted_student_id && (
                      <Link className="underline" to={`/students/${d.lead.converted_student_id}`}>
                        Open the student
                      </Link>
                    )}
                  </p>
                ) : (
                  <AdmitForm snapshot={snap} lead={d} />
                )
              }
            </DataState>
          ) : (
            <AdmitForm snapshot={snap} lead={null} />
          )
        }
      </DataState>
    </div>
  );
}
