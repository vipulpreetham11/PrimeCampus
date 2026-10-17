import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { calendarSchema, type Calendar } from '@/contracts/setup';
import {
  SCHEDULE_PRESETS,
  toSlotsPayload,
  validateSchedule,
  type ScheduleDraft,
} from '@/features/setup/bell';
import { BellScheduleEditor } from '@/features/setup/BellScheduleEditor';
import { CalendarMonth } from '@/features/setup/CalendarMonth';
import { buildMonthGrid, isoWeekday, monthsBetween } from '@/features/setup/calendar-model';

const base = (): ScheduleDraft => ({
  name: 'Regular',
  kind: 'regular',
  day_start: '08:00',
  day_end: '13:00',
  effective_from: '2026-06-01',
  slots: [
    { label: 'Period 1', kind: 'period', start_time: '08:00', end_time: '08:40' },
    { label: 'Break', kind: 'break', start_time: '08:40', end_time: '08:55' },
    { label: 'Period 2', kind: 'period', start_time: '08:55', end_time: '09:35' },
  ],
});
const messages = (d: ScheduleDraft) => validateSchedule(d).map((i) => i.message);

describe('bell schedule validation', () => {
  it('accepts a valid schedule', () => {
    expect(validateSchedule(base())).toEqual([]);
  });

  it('flags overlapping slots on the later slot', () => {
    const d = base();
    d.slots[2]!.start_time = '08:50';
    const issues = validateSchedule(d);
    expect(issues).toContainEqual({ slot: 2, message: 'Overlaps “Break”.' });
  });

  it('touching slots (end == next start) do not overlap', () => {
    expect(messages(base()).some((m) => m.startsWith('Overlaps'))).toBe(false);
  });

  it('requires slots inside the school day and end after start', () => {
    const d = base();
    d.slots[0]!.start_time = '07:30';
    d.slots[1]!.end_time = '08:40';
    const issues = validateSchedule(d);
    expect(issues).toContainEqual({ slot: 0, message: 'Must sit inside the school day.' });
    expect(issues).toContainEqual({ slot: 1, message: 'Ends before it starts.' });
  });

  it('checks the school day, name, slot count, labels and that a period exists', () => {
    expect(messages({ ...base(), day_end: '07:00' })).toContain('The school day must end after it starts.');
    expect(messages({ ...base(), name: '  ' })).toContain('Name must be 1–60 characters.');
    expect(messages({ ...base(), slots: [] })).toContain('Add at least one period.');
    expect(
      messages({
        ...base(),
        slots: [{ label: 'Lunch', kind: 'break', start_time: '08:00', end_time: '08:30' }],
      }),
    ).toContain('A bell schedule needs at least one teaching period.');
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      label: `P${i}`,
      kind: 'period' as const,
      start_time: '08:00',
      end_time: '08:01',
    }));
    expect(messages({ ...base(), slots: tooMany })).toContain('At most 20 periods and breaks.');
    const d = base();
    d.slots[0]!.label = '';
    expect(validateSchedule(d)).toContainEqual({ slot: 0, message: 'Label must be 1–40 characters.' });
  });

  it('payload orders slots by start time and numbers them 1..n', () => {
    const d = base();
    const reversed = [...d.slots].reverse();
    expect(toSlotsPayload(reversed).map((s) => [s.ordinal, s.label])).toEqual([
      [1, 'Period 1'],
      [2, 'Break'],
      [3, 'Period 2'],
    ]);
  });

  it.each(SCHEDULE_PRESETS.map((p) => [p.label, p] as const))(
    'preset “%s” produces a valid schedule',
    (_l, preset) => {
      const draft = preset.apply('2026-06-01');
      expect(validateSchedule(draft)).toEqual([]);
      expect(draft.effective_from).toBe('2026-06-01');
      expect(draft.slots.every((s) => s.kind === 'period' || s.kind === 'break')).toBe(true);
    },
  );

  it('presets match their names', () => {
    const full = SCHEDULE_PRESETS.find((p) => p.id === 'full-8')!.apply('2026-06-01');
    const half = SCHEDULE_PRESETS.find((p) => p.id === 'half-4')!.apply('2026-06-01');
    expect(full.slots.filter((s) => s.kind === 'period')).toHaveLength(8);
    expect(full.slots.some((s) => s.label === 'Lunch')).toBe(true);
    expect(half.slots.filter((s) => s.kind === 'period')).toHaveLength(4);
    expect(half.kind).toBe('half_day');
  });
});

describe('BellScheduleEditor', () => {
  it('a preset only prefills the form; saving sends the (editable) preset', async () => {
    const onSave = vi.fn();
    render(
      <BellScheduleEditor defaultEffectiveFrom="2026-06-01" onSave={onSave} onCancel={() => undefined} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Half day — 4 periods' }));
    expect(onSave).not.toHaveBeenCalled(); // prefill only
    expect(screen.getByLabelText('Name')).toHaveValue('Half day');
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Saturday');
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0]![0];
    expect(draft.name).toBe('Saturday');
    expect(draft.kind).toBe('half_day');
    expect(draft.slots.map((s: { ordinal: number }) => s.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it('shows overlap errors and does not save', async () => {
    const onSave = vi.fn();
    render(
      <BellScheduleEditor defaultEffectiveFrom="2026-06-01" onSave={onSave} onCancel={() => undefined} />,
    );
    await userEvent.click(screen.getByRole('button', { name: '8 periods + lunch' }));
    const row1 = screen.getByTestId('slot-row-1');
    const start = within(row1).getByLabelText('Starts');
    await userEvent.clear(start);
    await userEvent.type(start, '08:20');
    expect(within(row1).getByText('Overlaps “Period 1”.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ calendar
const year = {
  id: '77777777-7777-4777-8777-777777777777',
  name: '2026-27',
  start_date: '2026-06-01',
  end_date: '2027-04-30',
};
function calendar(): Calendar {
  return calendarSchema.parse({
    academic_year: year,
    audience: 'student',
    staff_group_id: null,
    patterns: [],
    overrides: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        date: '2026-10-21',
        day_type: 'holiday',
        period_schedule_id: null,
        label: 'Diwali',
        reason: 'Festival',
        is_exam_day: false,
        staff_group_id: null,
        version: 1,
      },
    ],
    resolved: [
      { date: '2026-10-19', day_type: 'working', weight: 1, period_schedule_id: null, label: null },
      { date: '2026-10-20', day_type: 'half_day', weight: 0.5, period_schedule_id: null, label: null },
      { date: '2026-10-21', day_type: 'holiday', weight: 0, period_schedule_id: null, label: 'Diwali' },
      { date: '2026-10-25', day_type: 'weekly_off', weight: 0, period_schedule_id: null, label: null },
    ],
    totals: { working_days: 1, half_days: 1, holidays: 1, weekly_offs: 1, working_weight: 1.5 },
  });
}

describe('calendar month', () => {
  it('weekday maths is zone-free', () => {
    expect(isoWeekday('2026-10-19')).toBe(1); // Monday
    expect(isoWeekday('2026-10-25')).toBe(7); // Sunday
    expect(monthsBetween('2026-06-01', '2027-04-30')).toHaveLength(11);
  });

  it('grid is Monday-first with padding', () => {
    const weeks = buildMonthGrid('2026-10', calendar().resolved);
    expect(weeks[0]!.slice(0, 3)).toEqual([null, null, null]); // 1 Oct 2026 is a Thursday
    expect(weeks[0]![3]!.date).toBe('2026-10-01');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it('renders every day type as text (not colour alone), marks overrides, and never shows missing days as working', () => {
    render(<CalendarMonth calendar={calendar()} month="2026-10" />);
    const day = (d: string) => screen.getByTestId(`day-${d}`);
    expect(day('2026-10-19')).toHaveAttribute('data-day-type', 'working');
    expect(within(day('2026-10-19')).getByText('Working day')).toBeInTheDocument();
    expect(within(day('2026-10-20')).getByText('Half day')).toBeInTheDocument();
    expect(within(day('2026-10-21')).getByText('Holiday')).toBeInTheDocument();
    expect(within(day('2026-10-21')).getByText('Diwali')).toBeInTheDocument();
    expect(within(day('2026-10-21')).getByLabelText('Changed for this date')).toBeInTheDocument();
    expect(within(day('2026-10-25')).getByText('Weekly off')).toBeInTheDocument();
    // not returned by the server → explicit "Not in year", never "Working day"
    expect(day('2026-10-02')).toHaveAttribute('data-day-type', 'none');
    expect(within(day('2026-10-02')).getByText('Not in year')).toBeInTheDocument();
  });

  it('phone list shows the same days with type text and the override reason', () => {
    render(<CalendarMonth calendar={calendar()} month="2026-10" />);
    const item = screen.getByTestId('list-day-2026-10-21');
    expect(item).toHaveTextContent('Wednesday, 21 October 2026');
    expect(item).toHaveTextContent('Holiday');
    expect(item).toHaveTextContent('Changed for this date: Festival');
    expect(
      screen.getAllByRole('listitem').filter((li) => li.dataset.testid?.startsWith('list-day-')),
    ).toHaveLength(4);
  });
});
