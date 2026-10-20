import { z } from '@/lib/zod';

// Operator console RPCs (1200 + 2400 maintenance + 2410 actor names). Operator-only: the server
// checks the live Operator grant on every call (private.require_operator); no context revision.

const id = z.guid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int();

export const auditEventSchema = z.object({
  id: z.number().int(),
  occurred_at: z.string(),
  actor_id: id.nullable(),
  actor_role: z.string().nullable(),
  via_operator: z.boolean(),
  app_session_id: id.nullable(),
  school_id: id.nullable(),
  academic_year_id: id.nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  operation_id: id.nullable(),
  /** Redacted as stored; shown as JSON. */
  detail: z.unknown(),
  actor_username: z.string().nullable(),
  actor_name: z.string().nullable(),
  school_name: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  items: z.array(auditEventSchema),
  /** Only on a full page (2410). */
  next_before_id: z.number().int().nullable(),
});

export const authEventSchema = z.object({
  id: z.number().int(),
  occurred_at: z.string(),
  /** null for a failed sign-in with no verified account. */
  account_id: id.nullable(),
  event: z.string(),
  outcome: z.enum(['success', 'failure']),
  actor_id: id.nullable(),
  app_session_id: id.nullable(),
  auth_session_id: id.nullable(),
  school_id: id.nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_class: z.string().nullable(),
  detail: z.unknown(),
  username: z.string().nullable(),
});
export type AuthEvent = z.infer<typeof authEventSchema>;

export const authPageSchema = z.object({
  items: z.array(authEventSchema),
  next_before_id: z.number().int().nullable(),
});

export const usageSchema = z.object({
  note: z.string(),
  daily: z.array(z.object({ day: isoDate, active_accounts: count, page_views: count })),
  logins: count,
  sessions: z.array(
    z.object({
      account: z.string(),
      started: z.string(),
      last_seen: z.string(),
      ended: z.string().nullable(),
      end_reason: z.string().nullable(),
      device_class: z.string().nullable(),
    }),
  ),
});
export type Usage = z.infer<typeof usageSchema>;

export const maintenanceSchema = z.object({
  retention: z
    .array(z.object({ key: z.string(), days: count, updated_at: z.string() }))
    .nullable()
    .transform((v) => v ?? []),
  schedule: z.array(z.object({ jobname: z.string(), schedule: z.string(), active: z.boolean() })),
  scheduled: z.boolean(),
  runs: z.array(
    z.object({
      ran_at: z.string(),
      trigger: z.enum(['schedule', 'operator']),
      result: z.record(z.string(), z.unknown()),
    }),
  ),
  open_sessions: count,
});
export type Maintenance = z.infer<typeof maintenanceSchema>;

export const retentionCleanupSchema = z.object({
  telemetry_deleted: count,
  usage_daily_deleted: count,
  auth_events_deleted: count,
  sessions_expired: count,
});
export type RetentionCleanup = z.infer<typeof retentionCleanupSchema>;
