import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TeacherSelect, useTeacherOptions } from '@/features/timetable/pickers';
import { addDays, daysBetween, formatDateTime, formatDayShort, formatTime, schoolToday } from '@/lib/dates';
import { useSubstitutions } from './hooks';

// Substitution history (brief §2): list_substitutions(from, to ≤ 63 days, staff?).

const STATUS_TEXT = { active: 'Current', replaced: 'Replaced', cancelled: 'Removed' } as const;

export function SubstitutionsPage() {
  const today = schoolToday();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(addDays(today, 7));
  const [staffId, setStaffId] = useState<string | null>(null);
  const { options: teachers } = useTeacherOptions();
  const span = from && to ? daysBetween(from, to) : -1;
  const valid = span >= 0 && span <= 62;
  const query = useSubstitutions(from, to, staffId, valid);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/schedule">
          <ArrowLeft aria-hidden="true" /> Schedule
        </Link>
      </Button>
      <PageHeader
        title="Substitution history"
        description="Who took which lesson instead of the planned teacher."
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="subs-from">From</Label>
          <DateInput id="subs-from" value={from} onChange={setFrom} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="subs-to">To</Label>
          <DateInput id="subs-to" value={to} onChange={setTo} />
        </div>
        {teachers.length > 0 && (
          <TeacherSelect id="subs-teacher" value={staffId} onChange={setStaffId} options={teachers} />
        )}
      </div>
      {!valid ? (
        <p role="alert" className="text-destructive text-sm">
          Choose a range of up to 63 days, with the end on or after the start.
        </p>
      ) : (
        <DataState query={query} isEmpty={(r) => r.length === 0} emptyTitle="No substitutions in this period">
          {(rows) => (
            <ul className="space-y-2" aria-label="Substitutions">
              {rows.map((s) => (
                <li key={s.substitution_id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {formatDayShort(s.date)} · {s.slot_label} ({formatTime(s.start_time)}) · {s.section} ·{' '}
                      {s.subject}
                    </span>
                    <Badge variant={s.status === 'active' ? 'default' : 'outline'}>
                      {STATUS_TEXT[s.status]}
                    </Badge>
                  </div>
                  <p className="mt-1">
                    {s.substitute_staff} instead of {s.original_staff ?? 'no planned teacher'}
                  </p>
                  {s.reason && <p className="text-muted-foreground">Note: {s.reason}</p>}
                  {s.conflict_override_reason && (
                    <p className="text-muted-foreground">
                      Assigned despite a clash/absence: {s.conflict_override_reason}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Assigned by {s.assigned_by ?? 'unknown'} on {formatDateTime(s.assigned_at)}
                    {s.ended_at && ` · ended by ${s.ended_by ?? 'unknown'} on ${formatDateTime(s.ended_at)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      )}
    </div>
  );
}
