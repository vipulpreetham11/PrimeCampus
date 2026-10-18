import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { useStaffList } from '@/features/staff/hooks';
import { useCan } from '@/lib/scope';

// Section and teacher pickers shared by the M2 screens (timetable, schedule, attendance, diary,
// homework). Sections come from the setup snapshot of the chosen year (default: current year);
// teachers from list_staff (active teaching staff).

const NONE = '__none__';

export interface SectionOption {
  id: string;
  label: string;
  classId: string;
  yearId: string;
}

/** Active sections of a year (null = current), in class order: "Class 1 A", "Class 1 B", … */
export function useSectionOptions(yearId: string | null = null) {
  const snapshot = useSetupSnapshot(yearId);
  const options = useMemo<SectionOption[]>(() => {
    const data = snapshot.data;
    if (!data) return [];
    const classes = new Map(data.classes.map((c) => [c.id, c]));
    return data.sections
      .filter((s) => s.status === 'active' && classes.get(s.class_id)?.status === 'active')
      .sort((a, b) => {
        const ca = classes.get(a.class_id);
        const cb = classes.get(b.class_id);
        return (
          (ca?.sort_order ?? 0) - (cb?.sort_order ?? 0) ||
          (ca?.name ?? '').localeCompare(cb?.name ?? '') ||
          a.sort_order - b.sort_order ||
          a.name.localeCompare(b.name)
        );
      })
      .map((s) => ({
        id: s.id,
        label: `${classes.get(s.class_id)?.name ?? ''} ${s.name}`.trim(),
        classId: s.class_id,
        yearId: s.academic_year_id,
      }));
  }, [snapshot.data]);
  return { options, query: snapshot };
}

/** Section names by id (any year in the snapshot) for ids that come back without a name. */
export function useSectionNames(yearId: string | null = null): Map<string, string> {
  const { options } = useSectionOptions(yearId);
  return useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options]);
}

export interface TeacherOption {
  id: string;
  name: string;
}

/** Active teaching staff (needs staff.read; empty otherwise). */
export function useTeacherOptions() {
  const canRead = useCan('staff.read');
  const staff = useStaffList(null, false, canRead);
  const options = useMemo<TeacherOption[]>(
    () =>
      (staff.data ?? [])
        .filter((s) => s.is_teaching && s.status === 'active')
        .map((s) => ({ id: s.staff_id, name: s.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [staff.data],
  );
  return { options, query: staff };
}

export function SectionSelect({
  id,
  label = 'Section',
  value,
  onChange,
  options,
  allowAll,
  allLabel = 'All sections',
  disabled,
}: {
  id: string;
  label?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: SectionOption[];
  allowAll?: boolean;
  allLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="min-h-11 w-full sm:w-56">
          <SelectValue placeholder="Choose a section" />
        </SelectTrigger>
        <SelectContent>
          {allowAll ? (
            <SelectItem value={NONE}>{allLabel}</SelectItem>
          ) : (
            value === null && (
              <SelectItem value={NONE} disabled>
                Choose a section
              </SelectItem>
            )
          )}
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function TeacherSelect({
  id,
  label = 'Teacher',
  value,
  onChange,
  options,
  noneLabel = 'All teachers',
  disabled,
}: {
  id: string;
  label?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: TeacherOption[];
  noneLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="min-h-11 w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
