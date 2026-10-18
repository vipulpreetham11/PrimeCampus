import { z } from 'zod';

// DTOs for staff RPCs (1300, 1800, 1900). Confidential finance lives in its own schema and
// its own query key — never merged into the general staff profile.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GENDERS = ['male', 'female', 'transgender'] as const;
export const TEACHING_KINDS = ['class_teacher', 'subject'] as const;

export const staffGroupSchema = z.object({
  id,
  name: z.string(),
  status: z.enum(['active', 'retired']),
  version: z.number().int(),
  staff_count: z.number().int(),
  /** null unless the caller may read staff finance (RLS) — or no default set. */
  default_monthly_salary_paise: z.number().int().nullable(),
});
export type StaffGroup = z.infer<typeof staffGroupSchema>;

export const staffListItemSchema = z.object({
  staff_id: id,
  employee_no: z.string(),
  name: z.string(),
  group: z.string(),
  staff_group_id: id,
  designation: z.string().nullable(),
  is_teaching: z.boolean(),
  phone: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  joined_on: isoDate,
  has_login: z.boolean(),
  version: z.number().int(),
});
export type StaffListItem = z.infer<typeof staffListItemSchema>;

export const loginRefSchema = z.object({ account_id: id, username: z.string(), status: z.string() });
export type LoginRef = z.infer<typeof loginRefSchema>;

export const staffRecordSchema = z.object({
  staff_id: id,
  employee_no: z.string(),
  full_name: z.string(),
  gender: z.enum(GENDERS).nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  staff_group_id: id,
  group: z.string(),
  designation: z.string().nullable(),
  is_teaching: z.boolean(),
  joined_on: isoDate,
  left_on: isoDate.nullable(),
  status: z.enum(['active', 'inactive']),
  has_login: z.boolean(),
  version: z.number().int(),
  login: loginRefSchema.nullable(),
  can: z.object({ edit: z.boolean(), finance: z.boolean(), link_login: z.boolean() }),
});
export type StaffRecord = z.infer<typeof staffRecordSchema>;

export const staffConfidentialSchema = z.object({
  salary_rates: z.array(
    z.object({
      monthly_salary_paise: z.number().int(),
      effective_from: isoDate,
      reason: z.string().nullable(),
    }),
  ),
  bank: z
    .object({
      account_holder_name: z.string(),
      account_number: z.string(),
      ifsc: z.string(),
      bank_name: z.string().nullable(),
    })
    .nullable(),
});
export type StaffConfidential = z.infer<typeof staffConfidentialSchema>;

export const teachingAssignmentSchema = z.object({
  id,
  academic_year_id: id,
  section_id: id,
  section: z.string(),
  staff_id: id,
  staff: z.string(),
  kind: z.enum(TEACHING_KINDS),
  subject_id: id.nullable(),
  subject: z.string().nullable(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
});
export type TeachingAssignment = z.infer<typeof teachingAssignmentSchema>;

export const staffGroupSavedSchema = z.object({ staff_group_id: id, version: z.number().int() });
export const staffSavedSchema = z.object({ staff_id: id, version: z.number().int() });
export const staffFinanceSavedSchema = z.object({ staff_id: id });
export const teachingAssignmentSavedSchema = z.object({ teaching_assignment_id: id });
export const teachingAssignmentEndedSchema = z.object({ teaching_assignment_id: id, effective_to: isoDate });
