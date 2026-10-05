export const ROLES = [
  'operator',
  'owner',
  'admin',
  'principal',
  'accountant',
  'teacher',
  'parent',
  'student',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  operator: 'Operator',
  owner: 'Owner',
  admin: 'Admin',
  principal: 'Principal',
  accountant: 'Accountant',
  teacher: 'Teacher',
  parent: 'Parent',
  student: 'Student',
};

export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}
