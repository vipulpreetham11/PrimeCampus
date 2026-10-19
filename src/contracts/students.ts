import { z } from '@/lib/zod';
import { loginRefSchema } from './staff';

// DTOs for students & guardians (1000, 1300, 1800, 1900).

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RELATIONSHIPS = ['mother', 'father', 'guardian', 'grandparent', 'sibling', 'other'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const STUDENT_STATUSES = ['active', 'inactive', 'archived'] as const;
export const SOCIAL_CATEGORIES = ['general', 'sc', 'st', 'obc'] as const;
export const MINORITY_GROUPS = [
  'muslim',
  'christian',
  'sikh',
  'buddhist',
  'parsi',
  'jain',
  'not_applicable',
] as const;
export const MAINSTREAMED_IN = ['current_year', 'earlier_year'] as const;

export const studentListItemSchema = z.object({
  student_id: id,
  name: z.string(),
  admission_no: z.string(),
  status: z.enum(STUDENT_STATUSES),
  class: z.string().nullable(),
  section: z.string().nullable(),
  section_id: id.nullable(),
  roll_no: z.string().nullable(),
});
export type StudentListItem = z.infer<typeof studentListItemSchema>;

export const studentPageSchema = z.object({
  items: z.array(studentListItemSchema),
  next_cursor: z.object({ after_name: z.string(), after_id: id }).nullable(),
});
export type StudentPage = z.infer<typeof studentPageSchema>;

export const studentCoreSchema = z.object({
  id,
  admission_no: z.string(),
  full_name: z.string(),
  gender: z.enum(['male', 'female', 'transgender']),
  date_of_birth: isoDate,
  mother_name: z.string().nullable(),
  father_name: z.string().nullable(),
  guardian_name: z.string().nullable(),
  address_line: z.string().nullable(),
  pincode: z.string().nullable(),
  mobile: z.string().nullable(),
  alt_mobile: z.string().nullable(),
  email: z.string().nullable(),
  mother_tongue: z.string().nullable(),
  is_indian_national: z.boolean(),
  nationality: z.string().nullable(),
  blood_group: z.enum(BLOOD_GROUPS).nullable(),
  admission_date: isoDate,
  previous_school: z.string().nullable(),
  previous_class: z.string().nullable(),
  status: z.enum(STUDENT_STATUSES),
  version: z.number().int(),
});
export type StudentCore = z.infer<typeof studentCoreSchema>;

export const studentSensitiveSchema = z.object({
  name_as_per_aadhaar: z.string().nullable(),
  aadhaar_number: z.string().nullable(),
  student_national_code: z.string().nullable(),
  apaar_id: z.string().nullable(),
  social_category: z.enum(SOCIAL_CATEGORIES).nullable(),
  minority_group: z.enum(MINORITY_GROUPS).nullable(),
  is_bpl: z.boolean().nullable(),
  is_aay: z.boolean().nullable(),
  is_ews_disadvantaged: z.boolean().nullable(),
  is_cwsn: z.boolean().nullable(),
  impairment_type: z.string().nullable(),
  has_disability_cert: z.boolean().nullable(),
  disability_percent: z.number().int().nullable(),
  is_out_of_school_child: z.boolean().nullable(),
  mainstreamed_in: z.enum(MAINSTREAMED_IN).nullable(),
  family_annual_income_paise: z.number().int().nullable(),
});
export type StudentSensitive = z.infer<typeof studentSensitiveSchema>;

export const profileGuardianSchema = z.object({
  guardian_id: id,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  occupation: z.string().nullable(),
  relationship: z.enum(RELATIONSHIPS),
  is_primary: z.boolean(),
  portal_access: z.boolean(),
  has_login: z.boolean(),
  version: z.number().int(),
});
export type ProfileGuardian = z.infer<typeof profileGuardianSchema>;

export const studentProfileSchema = z.object({
  profile: studentCoreSchema,
  age_today: z.number().nullable(),
  guardians: z.array(profileGuardianSchema),
  placements: z.array(
    z.object({
      section_id: id,
      class: z.string(),
      section: z.string(),
      roll_no: z.string().nullable(),
      from: isoDate,
      to: isoDate.nullable(),
      reason: z.string().nullable(),
      year: z.string(),
    }),
  ),
  sensitive: studentSensitiveSchema.nullable(),
  login: loginRefSchema.nullable(),
  can: z.object({
    edit: z.boolean(),
    fees: z.boolean(),
    attendance: z.boolean(),
    link_login: z.boolean(),
  }),
});
export type StudentProfile = z.infer<typeof studentProfileSchema>;

export const guardianRecordSchema = z.object({
  guardian_id: id,
  full_name: z.string(),
  phone: z.string().nullable(),
  alt_phone: z.string().nullable(),
  email: z.string().nullable(),
  occupation: z.string().nullable(),
  address_line: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  has_login: z.boolean(),
  version: z.number().int(),
  children: z.array(
    z.object({
      student_id: id,
      name: z.string(),
      admission_no: z.string(),
      relationship: z.enum(RELATIONSHIPS),
      is_primary: z.boolean(),
      portal_access: z.boolean(),
    }),
  ),
  login: loginRefSchema.nullable(),
  can: z.object({ edit: z.boolean(), link_login: z.boolean() }),
});
export type GuardianRecord = z.infer<typeof guardianRecordSchema>;

export const guardianSearchItemSchema = z.object({
  guardian_id: id,
  full_name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  has_login: z.boolean(),
  status: z.string(),
  version: z.number().int(),
  children: z.array(
    z.object({
      student_id: id,
      name: z.string(),
      admission_no: z.string(),
      relationship: z.enum(RELATIONSHIPS),
    }),
  ),
});
export type GuardianSearchItem = z.infer<typeof guardianSearchItemSchema>;

export const studentUpdatedSchema = z.object({ student_id: id, version: z.number().int() });
export const sensitiveSavedSchema = z.object({ student_id: id });
export const guardianSavedSchema = z.object({
  guardian_id: id,
  version: z.number().int().nullable(),
  same_phone_guardians: z.array(z.object({ guardian_id: id, full_name: z.string() })),
});

export const placementPreviewRowSchema = z.object({
  student_id: id,
  from_section_id: id.nullable(),
  to_section_id: id,
  roll_no: z.string().nullable(),
  errors: z.array(z.string()),
  class_changes: z.boolean(),
  fee_note: z.string(),
  marks_after_move_in_old_section: z.number().int(),
});
export const movePlacementsSchema = z.union([
  z.object({ preview: z.literal(true), can_apply: z.boolean(), rows: z.array(placementPreviewRowSchema) }),
  z.object({
    preview: z.literal(false),
    batch_id: id,
    moved: z.number().int(),
    rows: z.array(placementPreviewRowSchema),
    replayed: z.boolean().optional(),
  }),
]);
export type MovePlacementsResult = z.infer<typeof movePlacementsSchema>;
