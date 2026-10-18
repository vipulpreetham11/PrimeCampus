import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { DateInput } from '@/components/shared/DateInput';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DAY_TYPES,
  PATTERN_DAY_TYPES,
  type Calendar,
  type DayType,
  type SetupSnapshot,
} from '@/contracts/setup';
import { compareIsoDates, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useStaffGroups } from '@/features/staff/hooks';
import { CalendarLegend, CalendarMonth } from './CalendarMonth';
import { DAY_TYPE_META, WEEKDAYS, monthBounds, monthLabel, monthsBetween } from './calendar-model';
import { useCalendar, useSaveCalendarPattern, useSaveCalendarRange, useSetupSnapshot } from './hooks';
import { YearSelect, useSelectedYear } from './year';

type Audience = 'student' | 'staff';
const NONE = '__none__';

function ScheduleSelect({
  id,
  snapshot,
  value,
  onChange,
  required,
}: {
  id: string;
  snapshot: SetupSnapshot;
  value: string | null;
  onChange: (v: string | null) => void;
  required: boolean;
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id} className="w-full" aria-invalid={required && !value}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{required ? 'Choose a bell schedule' : 'Default bell schedule'}</SelectItem>
        {snapshot.period_schedules.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ------------------------------------------------------------------ weekly pattern editor
export function PatternDialog({
  calendar,
  snapshot,
  yearId,
  audience,
  staffGroupId,
  open,
  onOpenChange,
}: {
  calendar: Calendar;
  snapshot: SetupSnapshot;
  yearId: string;
  audience: Audience;
  staffGroupId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveCalendarPattern();
  const [error, setError] = useState<unknown>(null);
  // Rows for this audience/group; for a group, start from its own rows, else the school default.
  const [initial] = useState(() =>
    WEEKDAYS.map((w) => {
      const own = calendar.patterns.find((p) => p.weekday === w.iso && p.staff_group_id === staffGroupId);
      const fallback = calendar.patterns.find((p) => p.weekday === w.iso && p.staff_group_id === null);
      const p = own ?? fallback;
      return {
        weekday: w.iso,
        day_type: (p?.day_type ??
          (w.iso === 7 ? 'weekly_off' : 'working')) as (typeof PATTERN_DAY_TYPES)[number],
        period_schedule_id: p?.period_schedule_id ?? null,
        inherited: staffGroupId !== null && !own,
      };
    }),
  );
  const [rows, setRows] = useState(initial);
  const isChanged = (i: number) =>
    rows[i]!.day_type !== initial[i]!.day_type ||
    rows[i]!.period_schedule_id !== initial[i]!.period_schedule_id;
  // A staff group saves only the weekdays changed here; the rest keep following the school default.
  // The school default itself saves the whole week.
  const toSave = rows.filter((_, i) => staffGroupId === null || isChanged(i));
  // Student half days need a bell schedule (SQL check on calendar_patterns).
  const missing = rows.some(
    (r) => audience === 'student' && r.day_type === 'half_day' && !r.period_schedule_id,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Weekly pattern</DialogTitle>
          <DialogDescription>
            The usual week for {audience === 'student' ? 'students' : 'staff'}. Holidays are set as date
            ranges, not here.
            {staffGroupId !== null &&
              ' Only the days you change are saved for this group; the others follow the school default.'}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const w = WEEKDAYS[i]!;
            return (
              <li
                key={w.iso}
                className="grid grid-cols-[6rem_1fr] items-center gap-2 sm:grid-cols-[6rem_9rem_1fr]"
              >
                <span>
                  <span className="block font-medium">{w.long}</span>
                  {staffGroupId !== null && (
                    <span className="text-muted-foreground block text-xs">
                      {isChanged(i) ? 'Changed' : r.inherited ? 'School default' : 'Set for this group'}
                    </span>
                  )}
                </span>
                <Select
                  value={r.day_type}
                  onValueChange={(v) =>
                    setRows((rs) =>
                      rs.map((x, k) => (k === i ? { ...x, day_type: v as typeof r.day_type } : x)),
                    )
                  }
                >
                  <SelectTrigger aria-label={`${w.long} day type`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PATTERN_DAY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {DAY_TYPE_META[t].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {r.day_type !== 'weekly_off' && (
                  <div className="col-span-2 sm:col-span-1">
                    <ScheduleSelect
                      id={`pattern-${w.iso}-schedule`}
                      snapshot={snapshot}
                      value={r.period_schedule_id}
                      onChange={(v) =>
                        setRows((rs) => rs.map((x, k) => (k === i ? { ...x, period_schedule_id: v } : x)))
                      }
                      required={audience === 'student' && r.day_type === 'half_day'}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {missing && <p className="text-destructive text-sm">Student half days need a bell schedule.</p>}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || missing}
            onClick={async () => {
              setError(null);
              if (toSave.length === 0) {
                toast.info('No changes to save.');
                onOpenChange(false);
                return;
              }
              try {
                await save.mutateAsync({
                  yearId,
                  audience,
                  staffGroupId,
                  patterns: toSave.map((r) => ({
                    weekday: r.weekday,
                    day_type: r.day_type,
                    period_schedule_id: r.day_type === 'weekly_off' ? null : r.period_schedule_id,
                  })),
                });
                toast.success('Weekly pattern saved.');
                onOpenChange(false);
              } catch (e) {
                setError(handleSaveError(e));
              }
            }}
          >
            {save.isPending ? 'Saving…' : 'Save pattern'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ date range editor
function RangeDialog({
  snapshot,
  yearId,
  yearStart,
  yearEnd,
  audience,
  staffGroupId,
  open,
  onOpenChange,
}: {
  snapshot: SetupSnapshot;
  yearId: string;
  yearStart: string;
  yearEnd: string;
  audience: Audience;
  staffGroupId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveCalendarRange();
  const [error, setError] = useState<unknown>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dayType, setDayType] = useState<DayType>('holiday');
  const [schedule, setSchedule] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [exam, setExam] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [touched, setTouched] = useState(false);

  const problems: string[] = [];
  if (!from || !to) problems.push('Choose the first and last date.');
  else if (compareIsoDates(to, from) < 0) problems.push('The last date must be on or after the first date.');
  if ((from && compareIsoDates(from, yearStart) < 0) || (to && compareIsoDates(to, yearEnd) > 0)) {
    problems.push('Dates must be inside the academic year.');
  }
  if (audience === 'student' && dayType === 'half_day' && !schedule)
    problems.push('Student half days need a bell schedule.');
  if (label.length > 120) problems.push('Label is too long (120 characters).');
  if (reason.length > 500) problems.push('Reason is too long (500 characters).');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Holidays, half days and exam days</DialogTitle>
          <DialogDescription>
            Applies to every date in the range (optionally only some weekdays). Attendance already marked on
            those dates is kept.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setTouched(true);
            if (problems.length > 0) return;
            setError(null);
            try {
              const res = await save.mutateAsync({
                yearId,
                audience,
                staffGroupId,
                from,
                to,
                day_type: dayType,
                period_schedule_id: dayType === 'half_day' || dayType === 'working' ? schedule : null,
                label: label.trim() || null,
                reason: reason.trim() || null,
                is_exam_day: exam,
                weekdays: weekdays.length > 0 ? weekdays : null,
              });
              toast.success(`${res.dates_saved} date(s) saved.${res.note ? ` ${res.note}` : ''}`);
              onOpenChange(false);
            } catch (err) {
              setError(handleSaveError(err));
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="range-from">First date</Label>
              <DateInput id="range-from" value={from} onChange={setFrom} min={yearStart} max={yearEnd} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-to">Last date</Label>
              <DateInput id="range-to" value={to} onChange={setTo} min={from || yearStart} max={yearEnd} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="range-type">Day type</Label>
            <Select value={dayType} onValueChange={(v) => setDayType(v as DayType)}>
              <SelectTrigger id="range-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DAY_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(dayType === 'half_day' || dayType === 'working') && (
            <div className="space-y-1">
              <Label htmlFor="range-schedule">Bell schedule</Label>
              <ScheduleSelect
                id="range-schedule"
                snapshot={snapshot}
                value={schedule}
                onChange={setSchedule}
                required={audience === 'student' && dayType === 'half_day'}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="range-label">Label (shown on the calendar)</Label>
            <Input
              id="range-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Diwali"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="range-reason">Reason (optional)</Label>
            <Input id="range-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={exam} onCheckedChange={(v) => setExam(v === true)} /> Exam day(s)
          </label>
          <fieldset>
            <legend className="mb-1 text-sm">Only these weekdays (optional)</legend>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((w) => (
                <label key={w.iso} className="flex items-center gap-1 text-sm">
                  <Checkbox
                    checked={weekdays.includes(w.iso)}
                    onCheckedChange={(v) =>
                      setWeekdays((ws) =>
                        v === true ? [...ws, w.iso].sort() : ws.filter((x) => x !== w.iso),
                      )
                    }
                  />
                  {w.short}
                </label>
              ))}
            </div>
          </fieldset>
          {touched && problems.length > 0 && (
            <ul role="alert" className="text-destructive list-inside list-disc text-sm">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save dates'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ page
export function CalendarPage() {
  const [yearId, setYearId] = useSelectedYear();
  const snapshot = useSetupSnapshot(yearId);
  const canManage = useCan('setup.manage');
  const canStaff = useCan('staff.member');
  const [audience, setAudience] = useState<Audience>('student');
  const [staffGroupId, setStaffGroupId] = useState<string | null>(null);
  const groups = useStaffGroups(canStaff && audience === 'staff');
  const [month, setMonth] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'pattern' | 'range' | null>(null);

  const year = snapshot.data?.academic_years.find(
    (y) => y.id === (yearId ?? snapshot.data?.selected_year_id),
  );
  const months = year ? monthsBetween(year.start_date, year.end_date) : [];
  const today = schoolToday();
  const defaultMonth = months.includes(today.slice(0, 7)) ? today.slice(0, 7) : (months[0] ?? null);
  const shownMonth = month && months.includes(month) ? month : defaultMonth;
  const bounds = shownMonth ? monthBounds(shownMonth) : null;
  const calendar = useCalendar({
    yearId: year?.id ?? null,
    audience,
    staffGroupId: audience === 'staff' ? staffGroupId : null,
    from: bounds?.from ?? null,
    to: bounds?.to ?? null,
  });
  const mi = shownMonth ? months.indexOf(shownMonth) : -1;

  return (
    <DataState query={snapshot}>
      {(snap) =>
        !year ? (
          <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
            Create an academic year first.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <YearSelect years={snap.academic_years} value={year.id} onChange={setYearId} />
              {canStaff && (
                <Tabs value={audience} onValueChange={(v) => setAudience(v as Audience)}>
                  <TabsList aria-label="Calendar for">
                    <TabsTrigger value="student">Students</TabsTrigger>
                    <TabsTrigger value="staff">Staff</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              {audience === 'staff' && (groups.data?.length ?? 0) > 0 && (
                <Select
                  value={staffGroupId ?? NONE}
                  onValueChange={(v) => setStaffGroupId(v === NONE ? null : v)}
                >
                  <SelectTrigger aria-label="Staff group" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>All staff (default)</SelectItem>
                    {groups.data!.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {canManage && (
                <div className="flex gap-2 sm:ml-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog('pattern')}
                    disabled={!calendar.data}
                  >
                    Weekly pattern
                  </Button>
                  <Button size="sm" onClick={() => setDialog('range')}>
                    Holidays &amp; special days
                  </Button>
                </div>
              )}
            </div>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous month"
                  disabled={mi <= 0}
                  onClick={() => setMonth(months[mi - 1]!)}
                >
                  <ChevronLeft />
                </Button>
                <CardTitle className="text-base" aria-live="polite">
                  {shownMonth ? monthLabel(shownMonth) : ''}
                </CardTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next month"
                  disabled={mi < 0 || mi >= months.length - 1}
                  onClick={() => setMonth(months[mi + 1]!)}
                >
                  <ChevronRight />
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <DataState query={calendar}>
                  {(cal) => (
                    <>
                      <dl
                        className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"
                        data-testid="calendar-totals"
                      >
                        <div className="rounded-md border p-2">
                          <dt className="text-muted-foreground">Working days</dt>
                          <dd className="text-lg font-semibold">{cal.totals.working_days}</dd>
                        </div>
                        <div className="rounded-md border p-2">
                          <dt className="text-muted-foreground">Half days</dt>
                          <dd className="text-lg font-semibold">{cal.totals.half_days}</dd>
                        </div>
                        <div className="rounded-md border p-2">
                          <dt className="text-muted-foreground">Holidays</dt>
                          <dd className="text-lg font-semibold">{cal.totals.holidays}</dd>
                        </div>
                        <div className="rounded-md border p-2">
                          <dt className="text-muted-foreground">Weekly offs</dt>
                          <dd className="text-lg font-semibold">{cal.totals.weekly_offs}</dd>
                        </div>
                      </dl>
                      {cal.patterns.length === 0 && (
                        <p className="text-muted-foreground text-sm">
                          No weekly pattern yet: every day shows as a weekly off until one is saved.
                        </p>
                      )}
                      <CalendarLegend />
                      {shownMonth && <CalendarMonth calendar={cal} month={shownMonth} />}
                      {canManage && dialog === 'pattern' && (
                        <PatternDialog
                          calendar={cal}
                          snapshot={snap}
                          yearId={year.id}
                          audience={audience}
                          staffGroupId={audience === 'staff' ? staffGroupId : null}
                          open
                          onOpenChange={(o) => !o && setDialog(null)}
                        />
                      )}
                    </>
                  )}
                </DataState>
              </CardContent>
            </Card>
            {canManage && dialog === 'range' && (
              <RangeDialog
                snapshot={snap}
                yearId={year.id}
                yearStart={year.start_date}
                yearEnd={year.end_date}
                audience={audience}
                staffGroupId={audience === 'staff' ? staffGroupId : null}
                open
                onOpenChange={(o) => !o && setDialog(null)}
              />
            )}
          </div>
        )
      }
    </DataState>
  );
}
