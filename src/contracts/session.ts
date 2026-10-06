import { z } from 'zod';
import { ROLES } from './roles';

// DTOs for the session/context RPCs (migration 0900) and the Operator school list (1600).
// Unknown extra fields are allowed (zod strips them) so additive server changes don't break the app.

const uuid = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const childCardSchema = z.object({
  student_id: uuid,
  name: z.string(),
  class_section: z.string().nullable().optional(),
});
export type ChildCard = z.infer<typeof childCardSchema>;

export const availableContextSchema = z.object({
  membership_id: uuid,
  school_id: uuid,
  school_name: z.string(),
  role: z.enum(ROLES),
  children: z.array(childCardSchema).nullable().optional(),
});
export type AvailableContext = z.infer<typeof availableContextSchema>;

export const bootstrapSchema = z.object({
  account_id: uuid,
  username: z.string(),
  display_name: z.string().nullable(),
  must_change_password: z.boolean(),
  is_operator: z.boolean().optional().default(false),
  new_session: z.boolean().optional(),
  contexts: z.array(availableContextSchema),
  selected: z
    .object({
      membership_id: uuid.nullable(),
      operator_school_id: uuid.nullable(),
      student_id: uuid.nullable(),
      context_revision: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type Bootstrap = z.infer<typeof bootstrapSchema>;

export const selectContextResultSchema = z.object({
  context_revision: z.number().int(),
  school_id: uuid,
  role: z.enum(ROLES),
  student_id: uuid.nullable(),
  membership_id: uuid.nullable(),
});

export const academicYearSchema = z.object({
  id: uuid,
  name: z.string(),
  start_date: isoDate,
  end_date: isoDate,
});

export const contextSchema = z.object({
  school_id: uuid,
  school_name: z.string(),
  role: z.enum(ROLES),
  via_operator: z.boolean(),
  student_id: uuid.nullable(),
  staff_id: uuid.nullable(),
  context_revision: z.number().int(),
  current_year: academicYearSchema.nullable(),
  // jsonb_agg over zero rows is null
  capabilities: z
    .array(z.string())
    .nullable()
    .transform((v) => v ?? []),
});
export type ActiveContext = z.infer<typeof contextSchema>;

export const endSessionSchema = z.object({ ended: z.boolean() });

export const operatorSchoolSchema = z.object({
  school_id: uuid,
  name: z.string(),
  code: z.string(),
  status: z.string(),
  organization_id: uuid,
  organization_name: z.string(),
  organization_code: z.string().nullable(),
  created_at: z.string(),
});
export type OperatorSchool = z.infer<typeof operatorSchoolSchema>;

export const createSchoolResultSchema = z.object({ organization_id: uuid, school_id: uuid });

export const foundAccountSchema = z
  .object({
    account_id: uuid,
    username: z.string(),
    display_name: z.string().nullable(),
    status: z.string(),
    must_change_password: z.boolean(),
    memberships: z.array(
      z.object({ membership_id: uuid, school_id: uuid, role: z.string(), status: z.string() }),
    ),
  })
  .nullable();
export type FoundAccount = z.infer<typeof foundAccountSchema>;

export const telemetryResultSchema = z.object({ accepted: z.number().int() });
