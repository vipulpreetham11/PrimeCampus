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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import type { ClassRow, ClassSubject, SectionRow, SetupSnapshot } from '@/contracts/setup';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import {
  useClassSubjects,
  useSaveClass,
  useSaveClassSubjects,
  useSaveSection,
  useSetupSnapshot,
} from './hooks';
import { YearSelect, useSelectedYear } from './year';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired (kept for history)' },
] as const;

const intText = (min: number, max: number, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max, msg);

// ------------------------------------------------------------------ class dialog
const classSchema = z.object({
  name: z.string().trim().min(1, 'Enter a class name').max(40),
  sort_order: intText(0, 32767, 'A whole number (0 or more)'),
  status: z.enum(['active', 'retired']),
});
type ClassValues = z.infer<typeof classSchema>;

function ClassDialog({
  cls,
  nextOrder,
  open,
  onOpenChange,
  onReload,
}: {
  cls: ClassRow | null;
  nextOrder: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  const save = useSaveClass();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<ClassValues>({
    resolver: zodResolver(classSchema),
    defaultValues: cls
      ? { name: cls.name, sort_order: String(cls.sort_order), status: cls.status }
      : { name: '', sort_order: String(nextOrder), status: 'active' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({
        name: v.name,
        sort_order: Number(v.sort_order),
        status: v.status,
        ...(cls ? { id: cls.id, version: cls.version } : {}),
      });
      toast.success(cls ? 'Class updated.' : 'Class created.');
      onOpenChange(false);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cls ? `Edit ${cls.name}` : 'New class'}</DialogTitle>
          <DialogDescription>
            Classes are school-wide; sections belong to one academic year.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField control={form.control} name="name" label="Class name" placeholder="Class 1" />
            <TextField
              control={form.control}
              name="sort_order"
              label="Order"
              inputMode="numeric"
              description="Lower numbers are listed first."
            />
            {cls && (
              <SelectField control={form.control} name="status" label="Status" options={STATUS_OPTIONS} />
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

// ------------------------------------------------------------------ section dialog
const sectionSchema = z.object({
  name: z.string().trim().min(1, 'Enter a section name').max(20),
  capacity: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 200),
      '1–200, or leave empty',
    ),
  sort_order: intText(0, 32767, 'A whole number (0 or more)'),
  status: z.enum(['active', 'retired']),
});
type SectionValues = z.infer<typeof sectionSchema>;

function SectionDialog({
  section,
  cls,
  yearId,
  nextOrder,
  open,
  onOpenChange,
  onReload,
}: {
  section: SectionRow | null;
  cls: ClassRow;
  yearId: string;
  nextOrder: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReload: () => void;
}) {
  const save = useSaveSection();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<SectionValues>({
    resolver: zodResolver(sectionSchema),
    defaultValues: section
      ? {
          name: section.name,
          capacity: section.capacity === null ? '' : String(section.capacity),
          sort_order: String(section.sort_order),
          status: section.status,
        }
      : { name: '', capacity: '', sort_order: String(nextOrder), status: 'active' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({
        academic_year_id: section?.academic_year_id ?? yearId,
        class_id: cls.id,
        name: v.name,
        capacity: v.capacity === '' ? null : Number(v.capacity),
        sort_order: Number(v.sort_order),
        status: v.status,
        ...(section ? { id: section.id, version: section.version } : {}),
      });
      toast.success(section ? 'Section updated.' : 'Section created.');
      onOpenChange(false);
    } catch (e) {
      setError(handleSaveError(e, { reload: onReload, form }));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {section ? `Edit ${cls.name} ${section.name}` : `New section in ${cls.name}`}
          </DialogTitle>
          <DialogDescription>Capacity is a planning number; it does not block admissions.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField control={form.control} name="name" label="Section name" placeholder="A" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="capacity"
                label="Capacity (optional)"
                inputMode="numeric"
              />
              <TextField control={form.control} name="sort_order" label="Order" inputMode="numeric" />
            </div>
            {section && (
              <SelectField control={form.control} name="status" label="Status" options={STATUS_OPTIONS} />
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

// ------------------------------------------------------------------ class subjects editor
interface SubjectPick {
  include: boolean;
  is_optional: boolean;
  sort_order: string;
}

function ClassSubjectsDialog({
  cls,
  yearId,
  snapshot,
  open,
  onOpenChange,
}: {
  cls: ClassRow;
  yearId: string;
  snapshot: SetupSnapshot;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const query = useClassSubjects(open ? yearId : null, cls.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Subjects for {cls.name}</DialogTitle>
          <DialogDescription>
            Saving replaces this class&apos;s subject list for the selected year. Subjects you untick are
            retired, not deleted.
          </DialogDescription>
        </DialogHeader>
        <DataState query={query}>
          {(current) => (
            <ClassSubjectsForm
              key={current.map((c) => c.id).join()}
              cls={cls}
              yearId={yearId}
              snapshot={snapshot}
              current={current}
              onDone={() => onOpenChange(false)}
            />
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}

function ClassSubjectsForm({
  cls,
  yearId,
  snapshot,
  current,
  onDone,
}: {
  cls: ClassRow;
  yearId: string;
  snapshot: SetupSnapshot;
  current: ClassSubject[];
  onDone: () => void;
}) {
  const save = useSaveClassSubjects();
  const [error, setError] = useState<unknown>(null);
  const subjects = snapshot.subjects.filter((s) => s.status === 'active');
  // Saving is a full replace: mappings to subjects retired since are kept as they are (read-only),
  // so saving here never silently drops them.
  const activeIds = new Set(subjects.map((s) => s.id));
  const retiredKept = current.filter((c) => !activeIds.has(c.subject_id));
  const [picks, setPicks] = useState<Record<string, SubjectPick>>(() =>
    Object.fromEntries(
      subjects.map((s, i) => {
        const cur = current.find((c) => c.subject_id === s.id);
        return [
          s.id,
          {
            include: !!cur,
            is_optional: cur?.is_optional ?? false,
            sort_order: String(cur?.sort_order ?? i + 1),
          },
        ];
      }),
    ),
  );
  const badOrder = Object.values(picks).some((p) => p.include && !/^\d{1,4}$/.test(p.sort_order.trim()));

  if (subjects.length === 0 && retiredKept.length === 0) {
    return <p className="text-muted-foreground text-sm">Add subjects first (Subjects tab).</p>;
  }
  const set = (id: string, patch: Partial<SubjectPick>) =>
    setPicks((p) => ({ ...p, [id]: { ...p[id]!, ...patch } }));

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-md border">
        {subjects.map((s) => {
          const p = picks[s.id]!;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
              <label className="flex min-w-40 flex-1 items-center gap-2">
                <Checkbox checked={p.include} onCheckedChange={(v) => set(s.id, { include: v === true })} />
                <span>
                  {s.name} <span className="text-muted-foreground text-xs">({s.code})</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={p.is_optional}
                  disabled={!p.include}
                  onCheckedChange={(v) => set(s.id, { is_optional: v === true })}
                />
                Optional
              </label>
              <label className="flex items-center gap-2 text-sm">
                Order
                <Input
                  className="w-16"
                  inputMode="numeric"
                  value={p.sort_order}
                  disabled={!p.include}
                  aria-invalid={p.include && !/^\d{1,4}$/.test(p.sort_order.trim())}
                  onChange={(e) => set(s.id, { sort_order: e.target.value })}
                />
              </label>
            </li>
          );
        })}
      </ul>
      {retiredKept.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Retired subjects still on this class</p>
          <ul className="divide-y rounded-md border" aria-label="Retired subjects (kept)">
            {retiredKept.map((c) => (
              <li key={c.subject_id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="min-w-40 flex-1">
                  {c.subject} <span className="text-muted-foreground text-xs">({c.code})</span>
                </span>
                <Badge variant="outline">Retired</Badge>
                {c.is_optional && <span className="text-muted-foreground">Optional</span>}
                <span className="text-muted-foreground">Order {c.sort_order}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            Kept unchanged when you save. Reactivate the subject on the Subjects tab to edit it here.
          </p>
        </div>
      )}
      {badOrder && <p className="text-destructive text-sm">Order must be a whole number.</p>}
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={save.isPending || badOrder}
          onClick={async () => {
            setError(null);
            try {
              await save.mutateAsync({
                yearId,
                classId: cls.id,
                subjects: [
                  ...Object.entries(picks)
                    .filter(([, p]) => p.include)
                    .map(([subject_id, p]) => ({
                      subject_id,
                      is_optional: p.is_optional,
                      sort_order: Number(p.sort_order),
                    })),
                  ...retiredKept.map((c) => ({
                    subject_id: c.subject_id,
                    is_optional: c.is_optional,
                    sort_order: c.sort_order,
                  })),
                ],
              });
              toast.success(`Subjects for ${cls.name} saved.`);
              onDone();
            } catch (e) {
              setError(handleSaveError(e));
            }
          }}
        >
          {save.isPending ? 'Saving…' : 'Save subjects'}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page
// Only ids are kept: the dialogs read the row from the latest snapshot and are keyed on its version, so
// after a CONFLICT + refetch they reopen on the current version instead of resending the old one.
type Open =
  | { kind: 'class'; clsId: string | null }
  | { kind: 'section'; clsId: string; sectionId: string | null }
  | { kind: 'subjects'; clsId: string }
  | null;

export function ClassesPage() {
  const [yearId, setYearId] = useSelectedYear();
  const query = useSetupSnapshot(yearId);
  const canManage = useCan('setup.manage');
  const [open, setOpen] = useState<Open>(null);
  const reload = () => void query.refetch();

  return (
    <DataState query={query}>
      {(snap) => {
        const year = snap.academic_years.find((y) => y.id === (yearId ?? snap.selected_year_id));
        const sectionsOf = (classId: string) => snap.sections.filter((s) => s.class_id === classId);
        const openClass = (open && open.clsId && snap.classes.find((c) => c.id === open.clsId)) || null;
        const openSection =
          (open?.kind === 'section' &&
            open.sectionId &&
            snap.sections.find((s) => s.id === open.sectionId)) ||
          null;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <YearSelect years={snap.academic_years} value={year?.id ?? null} onChange={setYearId} />
              {canManage && (
                <Button size="sm" onClick={() => setOpen({ kind: 'class', clsId: null })}>
                  New class
                </Button>
              )}
            </div>
            {!year && (
              <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                Create an academic year first — sections and class subjects belong to a year.
              </p>
            )}
            {snap.classes.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
                No classes yet.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {snap.classes.map((c) => (
                  <Card key={c.id} data-testid={`class-card-${c.name}`}>
                    <CardHeader className="flex flex-row items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">
                          {c.name} {c.status === 'retired' && <Badge variant="outline">Retired</Badge>}
                        </CardTitle>
                        <CardDescription>Order {c.sort_order}</CardDescription>
                      </div>
                      {canManage && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setOpen({ kind: 'class', clsId: c.id })}
                        >
                          Edit
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div>
                        <p className="mb-1 font-medium">Sections{year ? ` in ${year.name}` : ''}</p>
                        {sectionsOf(c.id).length === 0 ? (
                          <p className="text-muted-foreground">No sections in this year.</p>
                        ) : (
                          <ul className="flex flex-wrap gap-2">
                            {sectionsOf(c.id).map((s) => (
                              <li key={s.id}>
                                <button
                                  type="button"
                                  disabled={!canManage}
                                  onClick={() => setOpen({ kind: 'section', clsId: c.id, sectionId: s.id })}
                                  className="enabled:hover:bg-accent rounded-md border px-2 py-1 text-left disabled:cursor-default"
                                  aria-label={`Section ${c.name} ${s.name}${canManage ? ', edit' : ''}`}
                                >
                                  <span className="font-medium">{s.name}</span>
                                  <span className="text-muted-foreground ml-1 text-xs">
                                    {s.capacity !== null ? `cap ${s.capacity}` : 'no cap'}
                                    {s.status === 'retired' ? ' · retired' : ''}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      {canManage && year && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setOpen({ kind: 'section', clsId: c.id, sectionId: null })}
                          >
                            Add section
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setOpen({ kind: 'subjects', clsId: c.id })}
                          >
                            Subjects
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            {open?.kind === 'class' && (open.clsId === null || openClass) && (
              <ClassDialog
                key={openClass?.version ?? 'new'}
                cls={openClass}
                nextOrder={(snap.classes.at(-1)?.sort_order ?? 0) + 1}
                open
                onOpenChange={(o) => !o && setOpen(null)}
                onReload={reload}
              />
            )}
            {open?.kind === 'section' && openClass && year && (open.sectionId === null || openSection) && (
              <SectionDialog
                key={openSection?.version ?? 'new'}
                section={openSection}
                cls={openClass}
                yearId={year.id}
                nextOrder={sectionsOf(openClass.id).length}
                open
                onOpenChange={(o) => !o && setOpen(null)}
                onReload={reload}
              />
            )}
            {open?.kind === 'subjects' && openClass && year && (
              <ClassSubjectsDialog
                cls={openClass}
                yearId={year.id}
                snapshot={snap}
                open
                onOpenChange={(o) => !o && setOpen(null)}
              />
            )}
          </div>
        );
      }}
    </DataState>
  );
}
