import { useSearchParams } from 'react-router';
import { X } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AttendanceChange } from '@/contracts/reports';
import { roleLabel } from '@/contracts/roles';
import { SectionSelect, useSectionOptions } from '@/features/timetable/pickers';
import { addDays, daysBetween, formatDateTime, formatDayShort, isIsoDate, schoolToday } from '@/lib/dates';
import { useCan } from '@/lib/scope';
import { AttendanceTabs } from './AttendanceTabs';
import { useAttendanceChanges } from './hooks';

// Attendance changes: every correction of a mark — which mark, old → new, who (and in which role)
// and when. Student tab: attendance.read_all; staff tab: staff_attendance.read (server-enforced).

const STATUS_WORDS: Record<string, string> = { P: 'Present', L: 'Late', H: 'Half day', A: 'Absent' };

export function statusWord(s: string | null): string {
  if (s === null) return 'Not marked';
  return STATUS_WORDS[s] ?? s;
}

export function AttendanceChangesPage() {
  const canStudents = useCan('attendance.read_all');
  const canStaff = useCan('staff_attendance.read');
  const [params, setParams] = useSearchParams();
  const today = schoolToday();
  const kind: 'student' | 'staff' =
    (params.get('kind') === 'staff' && canStaff) || !canStudents ? 'staff' : 'student';
  const from = isIsoDate(params.get('from')) ? (params.get('from') as string) : addDays(today, -30);
  const to = isIsoDate(params.get('to')) ? (params.get('to') as string) : today;
  const sectionId = params.get('section');
  const personId = params.get('person');
  const span = daysBetween(from, to);
  const valid = span >= 0 && span <= 400;
  const { options: sections } = useSectionOptions();
  const query = useAttendanceChanges({ kind, from, to, sectionId, personId }, valid);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const personName = personId ? (items.find((i) => i.person_id === personId)?.person ?? 'one person') : null;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <AttendanceTabs />
      <PageHeader
        title="Attendance changes"
        description="Who changed which mark, from what to what, and when."
      />
      {canStudents && canStaff && (
        <Tabs
          value={kind}
          onValueChange={(v) => update({ kind: v === 'staff' ? 'staff' : null, section: null, person: null })}
        >
          <TabsList>
            <TabsTrigger value="student" className="min-h-9">
              Students
            </TabsTrigger>
            <TabsTrigger value="staff" className="min-h-9">
              Staff
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="changes-from">From</Label>
          <DateInput id="changes-from" value={from} onChange={(v) => v && update({ from: v })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="changes-to">To</Label>
          <DateInput id="changes-to" value={to} onChange={(v) => v && update({ to: v })} />
        </div>
        {kind === 'student' && (
          <SectionSelect
            id="changes-section"
            value={sectionId}
            onChange={(v) => update({ section: v })}
            options={sections}
            allowAll
          />
        )}
        {personId && (
          <Badge variant="secondary" className="min-h-9 gap-1 text-sm">
            Only {personName}
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Show everyone"
              onClick={() => update({ person: null })}
            >
              <X aria-hidden="true" />
            </Button>
          </Badge>
        )}
      </div>
      {!valid ? (
        <p className="text-destructive text-sm" role="alert">
          Choose a date range of up to 400 days, with “To” on or after “From”.
        </p>
      ) : (
        <DataState
          query={{ ...query, data: query.data ? items : undefined }}
          isEmpty={(rows) => rows.length === 0}
          emptyTitle="No changes in this range"
          emptyDescription="A first mark is not a change; only corrections of an existing mark are listed."
        >
          {(rows) => (
            <div className="space-y-3">
              <ul className="space-y-2" data-testid="attendance-changes">
                {rows.map((c) => (
                  <ChangeRow key={c.id} c={c} onPerson={() => update({ person: c.person_id })} />
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          )}
        </DataState>
      )}
    </div>
  );
}

function ChangeRow({ c, onPerson }: { c: AttendanceChange; onPerson: () => void }) {
  const role = c.changed_by_role ? roleLabel(c.changed_by_role) : null;
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="attendance-change">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onPerson}>
          {c.person ?? 'Unknown person'}
        </button>
        {c.admission_no && <span className="text-muted-foreground text-xs">{c.admission_no}</span>}
        <span className="text-muted-foreground">· {formatDayShort(c.attendance_date)}</span>
        {c.section && <span className="text-muted-foreground">· {c.section}</span>}
        {c.lesson && (
          <span className="text-muted-foreground">
            · {c.lesson.slot_label} {c.lesson.subject}
          </span>
        )}
      </div>
      <p className="mt-1" data-testid="change-statuses">
        <span>{statusWord(c.old_status)}</span> <span aria-hidden="true">→</span>{' '}
        <span className="sr-only">changed to</span>{' '}
        <span className="font-medium">{statusWord(c.new_status)}</span>
      </p>
      <p className="text-muted-foreground text-xs" data-testid="change-actor">
        Changed by {c.changed_by ?? 'unknown'}
        {role ? ` (${role})` : ''} · {formatDateTime(c.changed_at)}
      </p>
    </li>
  );
}
