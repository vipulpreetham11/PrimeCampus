import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { PageHeader } from '@/components/shared/PageHeader';
import {
  ChoiceGroup,
  RosterSaveBar,
  RowStateBadge,
  UnsavedChangesGuard,
  useRosterKeyboard,
} from '@/components/shared/roster-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ATTENDANCE_STATUSES, type AttendanceStatus, type StaffAttendance } from '@/contracts/attendance';
import { ConflictLine, STATUS_OPTIONS, STATUS_WORD } from '@/features/attendance/MarkingRosterPage';
import { useStaffGroups } from '@/features/staff/hooks';
import { addDays, formatDateLong, isIsoDate, schoolToday } from '@/lib/dates';
import {
  countStates,
  discardChanges,
  fillUnmarked,
  keepTheirs,
  pendingRows,
  reapplyMine,
  rowState,
  setValue,
  shownValue,
  strictEquals,
  type RosterRow,
} from '@/lib/roster';
import { useScopedKey } from '@/lib/scope';
import { useRosterSave, useServerRoster } from '@/lib/use-roster-save';
import { sendStaffMarks, useStaffAttendance } from './hooks';

// Staff attendance (brief §5): one register per date, optionally per staff group, with each person's
// staff-calendar day and paid leave. Read-only without staff_attendance.manage and for future dates.
// Same roster rules as student attendance: changed rows only, versions, conflicts, retry.

const ALL = '__all__';
const eq = strictEquals as (a: AttendanceStatus | null, b: AttendanceStatus | null) => boolean;

export function StaffAttendancePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('date');
  const date = raw && isIsoDate(raw) ? raw : schoolToday();
  const groupId = params.get('group');
  const groups = useStaffGroups();
  const query = useStaffAttendance(date, groupId);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staff attendance"
        description="Daily register for staff. Paid leave and staff holidays are shown per person."
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-end gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label="Previous day"
            onClick={() => set({ date: addDays(date, -1) })}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <div className="grid gap-1.5">
            <Label htmlFor="staff-att-date">Date</Label>
            <DateInput id="staff-att-date" value={date} onChange={(v) => v && set({ date: v })} />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-11 sm:size-9"
            aria-label="Next day"
            onClick={() => set({ date: addDays(date, 1) })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="staff-att-group">Staff group</Label>
          <Select value={groupId ?? ALL} onValueChange={(v) => set({ group: v === ALL ? null : v })}>
            <SelectTrigger id="staff-att-group" className="min-h-11 w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All groups</SelectItem>
              {(groups.data ?? []).map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DataState query={query}>
        {(data) => (
          <StaffRoster key={`${date}:${groupId ?? ''}`} data={data} reload={() => query.refetch()} />
        )}
      </DataState>
    </div>
  );
}

function StaffRoster({ data, reload }: { data: StaffAttendance; reload: () => Promise<unknown> }) {
  const key = useScopedKey();
  const qc = useQueryClient();
  const [roster, setRoster] = useServerRoster<AttendanceStatus, StaffAttendance>(
    data,
    (d) => d.staff.map((s) => ({ id: s.staff_id, value: s.status, version: s.version })),
    eq,
  );

  const readOnly = !data.can_mark || data.is_future;
  const options = ATTENDANCE_STATUSES.map((s) => STATUS_OPTIONS[s]);
  const send = useCallback(
    async (rows: RosterRow<AttendanceStatus>[], operationId: string) => {
      const res = await sendStaffMarks(
        data.date,
        operationId,
        rows.map((r) => ({
          staff_id: r.id,
          status: r.draft as AttendanceStatus,
          expected_version: r.baseVersion,
        })),
      );
      return {
        conflicts: res.conflicts.map((c) => ({
          id: c.staff_id,
          value: c.current_status,
          version: c.current_version,
        })),
      };
    },
    [data.date],
  );
  const payloadOf = useCallback(
    (rows: RosterRow<AttendanceStatus>[]) => ({
      date: data.date,
      marks: rows.map((r) => [r.id, r.draft, r.baseVersion]),
    }),
    [data.date],
  );
  const reloadAll = useCallback(
    () => Promise.all([reload(), qc.invalidateQueries({ queryKey: key('schedule') })]),
    [reload, qc, key],
  );
  const saver = useRosterSave<AttendanceStatus>({
    setRoster,
    batchSize: 200,
    send,
    payloadOf,
    reload: reloadAll,
  });
  const counts = countStates(roster);
  const pending = pendingRows(roster).length;
  const staff = data.staff;
  const change = (id: string, v: AttendanceStatus) => {
    if (saver.phase === 'saved') saver.acknowledge();
    setRoster((r) => setValue(r, id, v, eq));
  };
  const keyboard = useRosterKeyboard(staff.length, (i, k) => {
    const s = staff[i];
    if (!s || readOnly || saver.phase === 'saving' || !(ATTENDANCE_STATUSES as readonly string[]).includes(k))
      return false;
    change(s.staff_id, k as AttendanceStatus);
    return true;
  });

  if (staff.length === 0) {
    return (
      <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
        No staff employed on this date.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="staff-roster">
      <p className="text-sm font-medium">{formatDateLong(data.date)}</p>
      {readOnly && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border p-3 text-sm"
          data-testid="staff-readonly"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {data.is_future
            ? 'This date is in the future — staff attendance can only be marked on or after the day.'
            : 'You can see staff attendance but not change it.'}
        </p>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={counts.unmarked === 0 || saver.phase === 'saving'}
            onClick={() => setRoster((r) => fillUnmarked(r, 'P' as AttendanceStatus))}
          >
            {counts.unmarked === staff.length
              ? 'Mark all present'
              : `Mark remaining ${counts.unmarked} present`}
          </Button>
          {(pending > 0 || counts.conflict > 0) && (
            <Button variant="ghost" className="min-h-11" onClick={() => setRoster((r) => discardChanges(r))}>
              Undo unsaved changes
            </Button>
          )}
        </div>
      )}
      <ol className="divide-y rounded-lg border" aria-label="Staff" onKeyDown={keyboard.onKeyDown}>
        {staff.map((s, i) => {
          const row = roster.rows[s.staff_id];
          if (!row) return null;
          const state = rowState(row);
          const value = shownValue(row);
          const offDay = s.day !== null && (s.day.weight ?? 0) === 0;
          return (
            <li
              key={s.staff_id}
              {...keyboard.rowProps(i)}
              className="focus-visible:bg-accent/60 flex flex-wrap items-center gap-x-3 gap-y-2 p-3 outline-none"
              aria-label={`${s.name}: ${value ? STATUS_WORD[value] : 'unmarked'}`}
              data-testid="staff-row"
              data-staff={s.name}
              data-state={state}
            >
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-medium">{s.name}</p>
                <p className="text-muted-foreground text-xs">
                  {s.employee_no} · {s.group}
                  {s.day?.day_type && s.day.day_type !== 'working' && (
                    <>
                      {' '}
                      ·{' '}
                      {s.day.label ??
                        (s.day.day_type === 'half_day'
                          ? 'Half day'
                          : s.day.day_type === 'holiday'
                            ? 'Holiday'
                            : 'Weekly off')}
                    </>
                  )}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <RowStateBadge state={state} />
                  {s.paid_leave !== null && (
                    <Badge variant="outline">Paid leave{s.paid_leave < 1 ? ' (half day)' : ''}</Badge>
                  )}
                  {offDay && <Badge variant="outline">Not a working day</Badge>}
                </div>
              </div>
              <ChoiceGroup
                options={options}
                value={value}
                onChange={(v) => change(s.staff_id, v)}
                disabled={readOnly || saver.phase === 'saving'}
                label={`Attendance for ${s.name}`}
              />
              {row.conflict && (
                <ConflictLine
                  theirs={row.conflict.value}
                  mine={row.draft}
                  onMine={() => setRoster((r) => reapplyMine(r, s.staff_id))}
                  onTheirs={() => setRoster((r) => keepTheirs(r, s.staff_id))}
                />
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <RosterSaveBar
          summary={
            <span>
              {staff.length - counts.unmarked} of {staff.length} marked
              {counts.unmarked > 0 && <> · {counts.unmarked} unmarked</>}
              {pending > 0 && <> · {pending} not saved</>}
            </span>
          }
          pendingCount={pending}
          conflictCount={saver.conflictCount}
          phase={saver.phase}
          error={saver.error}
          onSave={() => void saver.save(roster)}
          saveLabel="Save staff attendance"
        />
      )}
      <UnsavedChangesGuard when={pending > 0 || counts.conflict > 0} />
    </div>
  );
}
