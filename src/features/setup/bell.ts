// Bell-schedule editor logic (pure; unit-tested). Mirrors the SQL rules in save_period_schedule and
// schedule_slots: slot kinds are only `period` | `break`, every slot sits inside the school day,
// end > start, 1–20 slots, labels 1–40 chars. The server stays authoritative.

export type SlotKind = 'period' | 'break';
export type ScheduleKind = 'regular' | 'half_day' | 'special';

export interface SlotDraft {
  label: string;
  kind: SlotKind;
  start_time: string; // 'HH:MM'
  end_time: string;
}

export interface ScheduleDraft {
  name: string;
  kind: ScheduleKind;
  day_start: string;
  day_end: string;
  effective_from: string;
  slots: SlotDraft[];
}

export interface ScheduleIssue {
  /** Slot index the issue belongs to, or null for schedule-level issues. */
  slot: number | null;
  message: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export function toMinutes(t: string): number | null {
  const m = TIME.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 'HH:MM:SS' from Postgres → 'HH:MM' for inputs. */
export function hhmm(t: string): string {
  return t.slice(0, 5);
}

function fromMinutes(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function validateSchedule(d: ScheduleDraft): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const name = d.name.trim();
  if (name.length < 1 || name.length > 60)
    issues.push({ slot: null, message: 'Name must be 1–60 characters.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.effective_from)) {
    issues.push({ slot: null, message: 'Choose the date this schedule starts.' });
  }
  const dayStart = toMinutes(d.day_start);
  const dayEnd = toMinutes(d.day_end);
  if (dayStart === null || dayEnd === null) {
    issues.push({ slot: null, message: 'Enter the school day start and end times.' });
  } else if (dayEnd <= dayStart) {
    issues.push({ slot: null, message: 'The school day must end after it starts.' });
  }
  if (d.slots.length === 0) issues.push({ slot: null, message: 'Add at least one period.' });
  if (d.slots.length > 20) issues.push({ slot: null, message: 'At most 20 periods and breaks.' });
  if (d.slots.length > 0 && !d.slots.some((s) => s.kind === 'period')) {
    issues.push({ slot: null, message: 'A bell schedule needs at least one teaching period.' });
  }

  const timed: { i: number; start: number; end: number }[] = [];
  d.slots.forEach((s, i) => {
    const label = s.label.trim();
    if (label.length < 1 || label.length > 40)
      issues.push({ slot: i, message: 'Label must be 1–40 characters.' });
    const start = toMinutes(s.start_time);
    const end = toMinutes(s.end_time);
    if (start === null || end === null) {
      issues.push({ slot: i, message: 'Enter start and end times.' });
      return;
    }
    if (end <= start) issues.push({ slot: i, message: 'Ends before it starts.' });
    if (dayStart !== null && dayEnd !== null && (start < dayStart || end > dayEnd)) {
      issues.push({ slot: i, message: 'Must sit inside the school day.' });
    }
    if (end > start) timed.push({ i, start, end });
  });

  timed.sort((a, b) => a.start - b.start);
  for (let k = 1; k < timed.length; k++) {
    const prev = timed[k - 1]!;
    const cur = timed[k]!;
    if (cur.start < prev.end) {
      issues.push({
        slot: cur.i,
        message: `Overlaps “${d.slots[prev.i]!.label.trim() || `row ${prev.i + 1}`}”.`,
      });
    }
  }
  return issues;
}

/** Payload for save_period_schedule: ordinals follow time order. */
export function toSlotsPayload(slots: SlotDraft[]) {
  return [...slots]
    .sort((a, b) => (toMinutes(a.start_time) ?? 0) - (toMinutes(b.start_time) ?? 0))
    .map((s, i) => ({
      ordinal: i + 1,
      label: s.label.trim(),
      kind: s.kind,
      start_time: s.start_time,
      end_time: s.end_time,
    }));
}

function build(start: string, parts: [string, SlotKind, number][]): { slots: SlotDraft[]; end: string } {
  let t = toMinutes(start)!;
  const slots = parts.map(([label, kind, minutes]) => {
    const s: SlotDraft = { label, kind, start_time: fromMinutes(t), end_time: fromMinutes(t + minutes) };
    t += minutes;
    return s;
  });
  return { slots, end: fromMinutes(t) };
}

export interface SchedulePreset {
  id: string;
  label: string;
  /** Prefills the form only; the user can edit everything before saving. */
  apply: (effectiveFrom: string) => ScheduleDraft;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: 'full-8',
    label: '8 periods + lunch',
    apply: (effective_from) => {
      const { slots, end } = build('08:00', [
        ['Period 1', 'period', 40],
        ['Period 2', 'period', 40],
        ['Period 3', 'period', 40],
        ['Short break', 'break', 15],
        ['Period 4', 'period', 40],
        ['Period 5', 'period', 40],
        ['Lunch', 'break', 30],
        ['Period 6', 'period', 40],
        ['Period 7', 'period', 40],
        ['Period 8', 'period', 40],
      ]);
      return {
        name: 'Regular day',
        kind: 'regular',
        day_start: '08:00',
        day_end: end,
        effective_from,
        slots,
      };
    },
  },
  {
    id: 'half-4',
    label: 'Half day — 4 periods',
    apply: (effective_from) => {
      const { slots, end } = build('08:00', [
        ['Period 1', 'period', 40],
        ['Period 2', 'period', 40],
        ['Break', 'break', 15],
        ['Period 3', 'period', 40],
        ['Period 4', 'period', 40],
      ]);
      return { name: 'Half day', kind: 'half_day', day_start: '08:00', day_end: end, effective_from, slots };
    },
  },
];

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  regular: 'Regular day',
  half_day: 'Half day',
  special: 'Special day',
};
