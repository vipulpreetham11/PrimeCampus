import { z } from 'zod';
import { ROLES } from './roles';

// DTOs for school user management (migration 1800).

const id = z.guid();
const schoolRole = z.enum(ROLES);

export const membershipSchema = z.object({
  membership_id: id,
  role: schoolRole,
  status: z.enum(['active', 'disabled']),
  admissions_duty: z.boolean(),
  version: z.number().int(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const schoolUserSchema = z.object({
  account_id: id,
  username: z.string(),
  display_name: z.string().nullable(),
  status: z.string(),
  must_change_password: z.boolean(),
  last_seen_at: z.string().nullable(),
  memberships: z
    .array(membershipSchema)
    .nullable()
    .transform((v) => v ?? []),
  staff: z.object({ staff_id: id, name: z.string(), employee_no: z.string() }).nullable(),
  guardian: z.object({ guardian_id: id, name: z.string() }).nullable(),
  student: z.object({ student_id: id, name: z.string(), admission_no: z.string() }).nullable(),
});
export type SchoolUser = z.infer<typeof schoolUserSchema>;

export const foundSchoolAccountSchema = z
  .object({
    account_id: id,
    username: z.string(),
    display_name: z.string().nullable(),
    status: z.string(),
    roles_here: z.array(z.object({ membership_id: id, role: schoolRole, status: z.string() })),
  })
  .nullable();
export type FoundSchoolAccount = z.infer<typeof foundSchoolAccountSchema>;

export const grantedMembershipSchema = z.object({
  membership_id: id,
  role: schoolRole,
  status: z.string(),
  admissions_duty: z.boolean(),
  version: z.number().int(),
});
export const admissionsDutySchema = z.object({
  membership_id: id,
  admissions_duty: z.boolean(),
  version: z.number().int(),
});
export const disabledMembershipSchema = z.object({ membership_id: id, status: z.literal('disabled') });
export const linkAccountResultSchema = z.object({
  kind: z.enum(['staff', 'guardian', 'student']),
  record_id: id,
  account_id: id.nullable(),
});

/** Roles an Admin can grant in a school (Operator is never a school role). */
export const GRANTABLE_ROLES = [
  'admin',
  'principal',
  'accountant',
  'owner',
  'teacher',
  'parent',
  'student',
] as const;
/** Admissions duty applies only to staff roles (private.grant_membership). */
export const DUTY_ROLES = ['admin', 'principal', 'accountant', 'teacher'] as const;
