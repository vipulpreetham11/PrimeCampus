// Capability names returned by get_context().capabilities (private.role_has_cap, last replaced in 2200).
// UI visibility is derived from these only — never from role names (CLAUDE.md rule 11).
export const CAPABILITIES = [
  'staff.member',
  'child.view',
  'lessons.teach',
  'setup.manage',
  'users.manage',
  'students.read_all',
  'students.manage',
  'students.sensitive',
  'admissions.manage',
  'imports.manage',
  'timetable.read_all',
  'timetable.manage',
  'attendance.read_all',
  'attendance.mark_any',
  'attendance.summary',
  'academic.read_all',
  'academic.correct',
  'fees.read',
  'fees.manage',
  'staff.read',
  'staff.manage',
  'staff_attendance.read',
  'staff_attendance.manage',
  'staff_finance.read',
  'staff_finance.manage',
  'export.full',
  'audit.read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}
