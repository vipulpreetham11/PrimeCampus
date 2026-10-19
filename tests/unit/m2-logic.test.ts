import { describe, expect, it } from 'vitest';
import { buildNav } from '@/app/navigation';
import { contextSchema } from '@/contracts/session';
import { blockReason } from '@/features/attendance/MarkingRosterPage';
import { markArgs } from '@/features/attendance/hooks';
import { homeworkFlags } from '@/features/child/ChildPages';
import { checkArgs, homeworkArgs } from '@/features/homework/hooks';
import { checkEquals, checkWord, serverCheck } from '@/features/homework/HomeworkRosterPage';
import { overrideQuestion } from '@/features/schedule/LessonActions';
import { staffMarkArgs } from '@/features/staff-attendance/hooks';
import {
  cellKey,
  cellsOffSchedule,
  conflictsByCell,
  entriesFromGrid,
  gridCounts,
  gridFromEntries,
  sameGrid,
  setCell,
} from '@/features/timetable/grid-model';
import { draftArgs } from '@/features/timetable/hooks';
import { validateRange } from '@/features/timetable/LessonsGenerate';
import { daysBetween, formatTime, isoWeekday, monthEnd, weekDates, weekStart } from '@/lib/dates';
import { AppError, toAppError } from '@/lib/errors';
import {
  applySaveResult,
  countStates,
  discardChanges,
  emptyRoster,
  fillUnmarked,
  keepTheirs,
  loadRoster,
  pendingRows,
  reapplyMine,
  rowState,
  setValue,
  shownValue,
  strictEquals,
  type Roster,
} from '@/lib/roster';
import { contextRow } from './fake-supabase';
import { CAPS, homeworkRosterRow, M2, periodRosterRow } from './m2-fixtures';

type S = 'P' | 'L' | 'H' | 'A';
const eq = strictEquals as (a: S | null, b: S | null) => boolean;
const load = (rows: [string, S | null, number | null][], prev: Roster<S> = emptyRoster()) =>
  loadRoster(
    prev,
    rows.map(([id, value, version]) => ({ id, value, version })),
    eq,
  );

// ------------------------------------------------------------------ roster state machine
describe('roster state machine', () => {
  const base = () =>
    load([
      ['a', null, null],
      ['b', null, null],
      ['c', 'P', 2],
    ]);

  it('unmarked rows are their own state — never present/absent', () => {
    const r = base();
    expect(rowState(r.rows.a!)).toBe('unmarked');
    expect(shownValue(r.rows.a!)).toBeNull();
    expect(rowState(r.rows.c!)).toBe('marked');
    expect(countStates(r)).toEqual({ unmarked: 2, marked: 1, changed: 0, conflict: 0 });
  });

  it('a change remembers the version the user saw; picking the saved value again clears it', () => {
    let r = setValue(base(), 'c', 'A', eq);
    expect(rowState(r.rows.c!)).toBe('changed');
    expect(r.rows.c!.baseVersion).toBe(2);
    // changing again keeps the ORIGINAL base version
    r = setValue(r, 'c', 'L', eq);
    expect(r.rows.c!.baseVersion).toBe(2);
    r = setValue(r, 'c', 'P', eq);
    expect(rowState(r.rows.c!)).toBe('marked');
    expect(pendingRows(r)).toHaveLength(0);
  });

  it('"mark remaining present" fills only unmarked rows (an existing mark is never overwritten)', () => {
    let r = setValue(base(), 'c', 'A', eq);
    r = fillUnmarked(r, 'P' as S);
    expect(shownValue(r.rows.a!)).toBe('P');
    expect(shownValue(r.rows.b!)).toBe('P');
    expect(shownValue(r.rows.c!)).toBe('A');
    expect(pendingRows(r).map((x) => [x.id, x.draft, x.baseVersion])).toEqual([
      ['a', 'P', null],
      ['b', 'P', null],
      ['c', 'A', 2],
    ]);
  });

  it('a reload keeps unsaved drafts (a failed save never drops marks) and keeps the base version', () => {
    let r = setValue(base(), 'c', 'A', eq);
    r = setValue(r, 'a', 'L', eq);
    // background reload: someone else changed c to L (version 3); a is still unmarked
    r = load(
      [
        ['a', null, null],
        ['b', null, null],
        ['c', 'L', 3],
      ],
      r,
    );
    expect(r.rows.a!.draft).toBe('L');
    expect(r.rows.c!.draft).toBe('A');
    // still the version the user saw → the server reports the conflict instead of overwriting
    expect(r.rows.c!.baseVersion).toBe(2);
  });

  it('a draft that the reload shows as saved is done', () => {
    let r = setValue(base(), 'a', 'P', eq);
    r = load(
      [
        ['a', 'P', 1],
        ['b', null, null],
        ['c', 'P', 2],
      ],
      r,
    );
    expect(rowState(r.rows.a!)).toBe('marked');
  });

  it('save result: sent rows are saved, conflicted rows keep the draft and show the other value', () => {
    let r = setValue(base(), 'a', 'P', eq);
    r = setValue(r, 'c', 'A', eq);
    r = applySaveResult(r, ['a', 'c'], [{ id: 'c', value: 'L', version: 3 }]);
    expect(rowState(r.rows.a!)).toBe('marked');
    expect(rowState(r.rows.c!)).toBe('conflict');
    expect(r.rows.c!.conflict).toEqual({ value: 'L', version: 3 });
    // conflicts wait for the user's decision; they are not resent
    expect(pendingRows(r)).toHaveLength(0);
  });

  it('conflict → "use mine" resends my value with THEIR version; "keep theirs" drops my draft', () => {
    let r = setValue(base(), 'c', 'A', eq);
    r = applySaveResult(r, ['c'], [{ id: 'c', value: 'L', version: 3 }]);
    const mine = reapplyMine(r, 'c');
    expect(pendingRows(mine).map((x) => [x.id, x.draft, x.baseVersion])).toEqual([['c', 'A', 3]]);
    const theirs = keepTheirs(r, 'c');
    expect(rowState(theirs.rows.c!)).toBe('marked');
    expect(shownValue(theirs.rows.c!)).toBe('L');
  });

  it('a reload during a conflict keeps the conflict with the latest value', () => {
    let r = setValue(base(), 'c', 'A', eq);
    r = applySaveResult(r, ['c'], [{ id: 'c', value: 'L', version: 3 }]);
    r = load(
      [
        ['a', null, null],
        ['b', null, null],
        ['c', 'H', 4],
      ],
      r,
    );
    expect(r.rows.c!.conflict).toEqual({ value: 'H', version: 4 });
  });

  it('undo discards drafts and conflicts', () => {
    let r = setValue(base(), 'a', 'P', eq);
    r = applySaveResult(setValue(r, 'c', 'A', eq), ['c'], [{ id: 'c', value: 'L', version: 3 }]);
    expect(countStates(discardChanges(r))).toEqual({ unmarked: 2, marked: 1, changed: 0, conflict: 0 });
  });
});

// ------------------------------------------------------------------ payloads
describe('RPC payloads', () => {
  it('mark_student_attendance: period sends the lesson; daily sends section + date', () => {
    const marks = [{ student_id: M2.s1, status: 'P' as const, expected_version: null }];
    expect(markArgs({ kind: 'period', lessonId: 501 }, 'op-1', marks)).toEqual({
      p_operation_id: 'op-1',
      p_kind: 'period',
      p_marks: [{ student_id: M2.s1, status: 'P', expected_version: null }],
      p_lesson_session_id: 501,
    });
    expect(
      markArgs({ kind: 'daily', sectionId: M2.sectionA, date: '2026-10-16' }, 'op-2', marks),
    ).toMatchObject({
      p_kind: 'daily',
      p_section_id: M2.sectionA,
      p_date: '2026-10-16',
    });
  });

  it('mark_staff_attendance carries the date and per-row versions', () => {
    expect(
      staffMarkArgs('2026-10-16', 'op', [{ staff_id: M2.meera, status: 'A', expected_version: 4 }]),
    ).toEqual({
      p_operation_id: 'op',
      p_date: '2026-10-16',
      p_marks: [{ staff_id: M2.meera, status: 'A', expected_version: 4 }],
    });
  });

  it('mark_homework_checks: completed_on only for completed work', () => {
    const args = checkArgs(M2.homework, '2026-10-17', 'op', [
      {
        student_id: M2.s1,
        completion: 'completed',
        correction: 'required',
        completed_on: '2026-10-17',
        comment: null,
        expected_version: null,
      },
      {
        student_id: M2.s2,
        completion: 'not_completed',
        correction: 'none',
        completed_on: '2026-10-17',
        comment: 'Absent',
        expected_version: 2,
      },
    ]);
    expect(args.p_checks).toEqual([
      {
        student_id: M2.s1,
        completion: 'completed',
        correction: 'required',
        completed_on: '2026-10-17',
        comment: null,
        expected_version: null,
      },
      {
        student_id: M2.s2,
        completion: 'not_completed',
        correction: 'none',
        completed_on: null,
        comment: 'Absent',
        expected_version: 2,
      },
    ]);
  });

  it('save_homework: create from a lesson / edit with version / cancel with version', () => {
    expect(
      homeworkArgs({ kind: 'create', lessonId: 7, dueOn: '2026-10-20', description: 'Read ch. 2' }),
    ).toEqual({
      p_lesson_session_id: 7,
      p_due_on: '2026-10-20',
      p_description: 'Read ch. 2',
    });
    expect(homeworkArgs({ kind: 'cancel', assignmentId: M2.homework, version: 3 })).toEqual({
      p_assignment_id: M2.homework,
      p_status: 'cancelled',
      p_expected_version: 3,
    });
  });

  it('save_timetable_draft: entries ordered, version + expected version only for an existing draft', () => {
    const entries = [
      { weekday: 2, slot_ordinal: 1, subject_id: M2.maths, staff_id: null },
      { weekday: 1, slot_ordinal: 4, subject_id: M2.english, staff_id: M2.meera },
    ];
    const created = draftArgs({
      sectionId: M2.sectionA,
      periodScheduleId: M2.schedule,
      effectiveFrom: '2026-10-19',
      entries,
      versionId: null,
      expectedVersion: null,
    });
    expect(created).not.toHaveProperty('p_version_id');
    expect(created).not.toHaveProperty('p_expected_version');
    expect(created.p_entries.map((e) => [e.weekday, e.slot_ordinal])).toEqual([
      [1, 4],
      [2, 1],
    ]);
    expect(
      draftArgs({
        sectionId: M2.sectionA,
        periodScheduleId: M2.schedule,
        effectiveFrom: '2026-10-19',
        entries,
        versionId: M2.version,
        expectedVersion: 3,
      }),
    ).toMatchObject({ p_version_id: M2.version, p_expected_version: 3 });
  });
});

// ------------------------------------------------------------------ timetable grid
describe('timetable grid model', () => {
  const grid = gridFromEntries([
    { weekday: 1, slot_ordinal: 1, subject_id: M2.maths, staff_id: M2.meera },
    { weekday: 1, slot_ordinal: 2, subject_id: M2.english, staff_id: null },
  ]);

  it('counts empty periods and lessons without a teacher (breaks are not periods)', () => {
    expect(gridCounts(grid, [1, 2], [1, 2, 4])).toEqual({ empty: 4, unassignedTeacher: 1, planned: 2 });
  });

  it('payload keeps only period slots of the chosen bell schedule', () => {
    const g = setCell(grid, cellKey(2, 3), { subject_id: M2.science, staff_id: null });
    expect(cellsOffSchedule(g, new Set([1, 2, 4]))).toBe(1);
    expect(entriesFromGrid(g, new Set([1, 2, 4])).map((e) => [e.weekday, e.slot_ordinal])).toEqual([
      [1, 1],
      [1, 2],
    ]);
  });

  it('clearing a cell and comparing grids', () => {
    const cleared = setCell(grid, cellKey(1, 2), null);
    expect(cleared.size).toBe(1);
    expect(
      sameGrid(
        grid,
        gridFromEntries(
          [...grid].map(([k, v]) => ({ weekday: Number(k[0]), slot_ordinal: Number(k[2]), ...v })),
        ),
      ),
    ).toBe(true);
    expect(sameGrid(grid, cleared)).toBe(false);
  });

  it('server clashes are grouped by cell', () => {
    const by = conflictsByCell([
      {
        weekday: 1,
        slot_ordinal: 1,
        staff_id: M2.meera,
        clashes_with_section_id: M2.sectionB,
        other_slot_ordinal: 1,
      },
    ]);
    expect(by.get(cellKey(1, 1))).toHaveLength(1);
    expect(by.get(cellKey(1, 2))).toBeUndefined();
  });

  it('lesson generation range: at most 63 days, end ≥ start', () => {
    expect(validateRange('2026-10-19', '2026-12-20')).toBeNull(); // 62 days apart = 63 dates
    expect(validateRange('2026-10-19', '2026-12-21')).toMatch(/63 days/);
    expect(validateRange('2026-10-19', '2026-10-18')).toMatch(/on or after/);
  });
});

// ------------------------------------------------------------------ dates
describe('week / month helpers', () => {
  it('ISO weekdays and Monday-first weeks', () => {
    expect(isoWeekday('2026-10-18')).toBe(7); // Sunday
    expect(isoWeekday('2026-10-19')).toBe(1);
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    expect(weekDates('2026-10-21')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it('month ends, day spans and school times', () => {
    expect(monthEnd('2027-02-03')).toBe('2027-02-28');
    expect(daysBetween('2026-10-19', '2026-12-20')).toBe(62);
    expect(formatTime('09:05:00')).toBe('9:05 am');
    expect(formatTime('12:30:00')).toBe('12:30 pm');
    expect(formatTime('00:10')).toBe('12:10 am');
  });
});

// ------------------------------------------------------------------ errors, rules, flags
describe('server details and rules', () => {
  it('a hinted error keeps its JSON details (never shown as text)', () => {
    const e = toAppError({
      code: 'P0001',
      hint: 'CONFLICT',
      message: 'This teacher is marked absent that day. Give a reason to assign anyway.',
      details: '{"has_conflict": false, "is_absent": true}',
    });
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ has_conflict: false, is_absent: true });
    expect(overrideQuestion(e)).toBe(
      'This teacher is marked absent that day. Give a reason to assign anyway.',
    );
    expect(toAppError({ hint: 'CONFLICT', message: 'x', details: '' }).details).toBeNull();
    expect(
      overrideQuestion(new AppError('CONFLICT', 'x', 'r', { has_conflict: true, is_absent: false })),
    ).toMatch(/another lesson at the same time/);
  });

  it('roster block reasons: cancelled lesson, holiday, mode mismatch, future date', () => {
    const today = '2026-10-19';
    const ok = periodRosterRow({ date: '2026-10-19' }) as never;
    expect(blockReason({ kind: 'period', lessonId: 501 }, ok, today)).toBeNull();
    expect(
      blockReason(
        { kind: 'period', lessonId: 501 },
        periodRosterRow({ lesson_status: 'cancelled' }) as never,
        today,
      )?.text,
    ).toMatch(/cancelled/);
    expect(
      blockReason(
        { kind: 'period', lessonId: 501 },
        periodRosterRow({
          day: {
            academic_year_id: null,
            day_type: 'holiday',
            weight: 0,
            period_schedule_id: null,
            label: 'Diwali',
          },
        }) as never,
        today,
      )?.text,
    ).toMatch(/not a working day/);
    const daily = blockReason(
      { kind: 'period', lessonId: 501 },
      periodRosterRow({ mode_on_date: 'daily' }) as never,
      today,
    );
    expect(daily).toMatchObject({ dailyLink: true });
    expect(
      blockReason({ kind: 'period', lessonId: 501 }, periodRosterRow({ date: '2026-10-20' }) as never, today)
        ?.text,
    ).toMatch(/on or after the day/);
  });

  it('homework check values: unchecked is null (never "not completed")', () => {
    const rows = homeworkRosterRow().students;
    expect(serverCheck(rows[0] as never)).toBeNull();
    expect(checkWord(null)).toBe('Unchecked');
    const done = serverCheck(rows[2] as never);
    expect(checkWord(done)).toBe('Completed');
    expect(
      checkWord({ completion: 'not_completed', correction: 'required', completed_on: null, comment: null }),
    ).toBe('Not completed, correction required');
    expect(checkEquals(done, { ...done!, comment: 'x' })).toBe(false);
  });

  it('parent homework flags: late completion / late check / due date passed while unchecked', () => {
    const base = {
      assignment_id: M2.homework,
      subject: 'Mathematics',
      assigned_by: 'Meera Rao',
      assigned_on: '2026-10-10',
      due_on: '2026-10-12',
      description: 'x',
      comment: null,
    };
    expect(
      homeworkFlags(
        {
          ...base,
          state: 'completed',
          correction: 'required',
          observed_on: '2026-10-14',
          completed_on: '2026-10-13',
          completed_after_due: true,
          observed_after_due: null,
        },
        '2026-10-19',
      ),
    ).toEqual(['Correction required', 'Completed after the due date']);
    expect(
      homeworkFlags(
        {
          ...base,
          state: 'unchecked',
          correction: null,
          observed_on: null,
          completed_on: null,
          completed_after_due: null,
          observed_after_due: null,
        },
        '2026-10-19',
      ),
    ).toEqual(['Due date passed']);
  });
});

// ------------------------------------------------------------------ navigation
describe('capability-driven navigation (never role names)', () => {
  const live = (caps: string[], role: string, student: string | null = null) =>
    buildNav(contextSchema.parse({ ...contextRow(1, role, caps), student_id: student }), false)
      .filter((i) => i.kind === 'live')
      .map((i) => `${i.label} ${i.to}`);

  it('teacher: home is Today; schedule, homework, diary, timetable; no overview or staff attendance', () => {
    const nav = live(CAPS.teacher, 'teacher');
    expect(nav[0]).toBe('Today /dashboard');
    expect(nav).toEqual(
      expect.arrayContaining([
        'Schedule /schedule',
        'Homework /homework',
        'Diary /diary',
        'Timetable /timetable',
      ]),
    );
    expect(nav.join()).not.toMatch(/\/attendance|staff-attendance|\/child/);
  });

  it('parent: home + the child pages only', () => {
    const nav = live(CAPS.parent, 'parent', M2.s1);
    expect(nav).toEqual([
      'Home /dashboard',
      'Timetable /child/timetable',
      'Homework /child/homework',
      'Attendance /child/attendance',
      'Diary /child/diary',
      // M3
      'Fees /child/fees',
    ]);
  });

  it('admin: every staff M2 area, daily-use areas before office set-up', () => {
    const nav = live(CAPS.admin, 'admin');
    expect(nav).toEqual(
      expect.arrayContaining([
        'Schedule /schedule',
        'Homework /homework',
        'Attendance /attendance',
        'Diary /diary',
        'Timetable /timetable',
        'Staff attendance /staff-attendance',
      ]),
    );
    expect(nav.indexOf('Schedule /schedule')).toBeLessThan(nav.indexOf('Students /students'));
    expect(nav.join()).not.toMatch(/\/child/);
  });

  it('principal: staff attendance and the overview, no lessons tool in the nav', () => {
    const nav = live(CAPS.principal, 'principal');
    expect(nav).toEqual(
      expect.arrayContaining(['Attendance /attendance', 'Staff attendance /staff-attendance']),
    );
    expect(nav[0]).toBe('Dashboard /dashboard');
  });

  it('M2 is no longer listed as "coming"', () => {
    const upcoming = buildNav(contextSchema.parse(contextRow(1, 'admin', CAPS.admin)), false).filter(
      (i) => i.kind === 'upcoming',
    );
    expect(upcoming.map((i) => (i.kind === 'upcoming' ? i.module : ''))).not.toContain('M2');
  });
});
