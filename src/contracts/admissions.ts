import { z } from 'zod';

// DTOs for admissions (1200, 1800, 1900).

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const LEAD_STAGES = ['new', 'contacted', 'visited', 'converted', 'lost'] as const;
export const LEAD_SOURCES = ['walk_in', 'website', 'referral', 'phone', 'other'] as const;
export const FOLLOWUP_CHANNELS = ['phone', 'walk_in', 'visit', 'whatsapp', 'email', 'other'] as const;
export const FOLLOWUP_OUTCOMES = [
  'reached',
  'no_answer',
  'callback_requested',
  'visit_scheduled',
  'visited',
  'not_interested',
  'other',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const leadSchema = z.object({
  id,
  academic_year_id: id.nullable(),
  parent_name: z.string(),
  phone: z.string(),
  alt_phone: z.string().nullable(),
  email: z.string().nullable(),
  child_name: z.string().nullable(),
  child_dob: isoDate.nullable(),
  interested_class_id: id.nullable(),
  source: z.enum(LEAD_SOURCES),
  source_detail: z.string().nullable(),
  stage: z.enum(LEAD_STAGES),
  lost_reason: z.string().nullable(),
  assigned_to: id.nullable(),
  next_follow_up_on: isoDate.nullable(),
  notes: z.string().nullable(),
  converted_student_id: id.nullable(),
  converted_at: z.string().nullable(),
  created_at: z.string(),
  version: z.number().int(),
});
export type Lead = z.infer<typeof leadSchema>;

export const leadPageSchema = z.object({
  items: z.array(leadSchema),
  next_cursor: z.object({ before_created_at: z.string(), before_id: id }).nullable(),
});
export type LeadPage = z.infer<typeof leadPageSchema>;

export const leadDetailSchema = z.object({
  lead: leadSchema,
  followups: z.array(
    z.object({
      id,
      contacted_at: z.string(),
      channel: z.enum(FOLLOWUP_CHANNELS),
      outcome: z.enum(FOLLOWUP_OUTCOMES),
      note: z.string().nullable(),
      next_follow_up_on: isoDate.nullable(),
      by: z.string().nullable(),
    }),
  ),
  same_phone: z.array(
    z.object({
      lead_id: id,
      parent_name: z.string(),
      child_name: z.string().nullable(),
      stage: z.enum(LEAD_STAGES),
    }),
  ),
});
export type LeadDetail = z.infer<typeof leadDetailSchema>;

export const followupDueSchema = z.object({
  lead_id: id,
  parent_name: z.string(),
  phone: z.string(),
  child_name: z.string().nullable(),
  stage: z.enum(LEAD_STAGES),
  next_follow_up_on: isoDate,
  assigned_to: id.nullable(),
  bucket: z.enum(['overdue', 'today', 'upcoming']),
  last_contact: z.string().nullable(),
});
export type FollowupDue = z.infer<typeof followupDueSchema>;

export const leadSavedSchema = z.object({
  lead_id: id,
  version: z.number().int(),
  possible_duplicates: z.array(
    z.object({
      lead_id: id,
      parent_name: z.string(),
      child_name: z.string().nullable(),
      stage: z.enum(LEAD_STAGES),
    }),
  ),
});
export const followupSavedSchema = z.object({ followup_id: id });

export const admitResultSchema = z.union([
  z.object({ student_id: id, replayed: z.literal(true), message: z.string() }),
  z.object({
    student_id: id,
    enrollment_id: id,
    placement_id: id,
    guardian_ids: z.array(id),
    lead_id: id.nullable(),
    parent_login_pending: z.boolean(),
    next_step: z.string(),
    replayed: z.boolean().optional(),
  }),
]);
export type AdmitResult = z.infer<typeof admitResultSchema>;
