import type { z } from 'zod';
import {
  bootstrapSchema,
  contextSchema,
  createSchoolResultSchema,
  endSessionSchema,
  foundAccountSchema,
  operatorSchoolSchema,
  selectContextResultSchema,
  telemetryResultSchema,
} from './session';
import { z as zod } from 'zod';

// Response schemas per RPC. The RPC layer validates a response when its function is listed
// here; otherwise the generated `Json` type is returned. Feature modules add their DTOs here
// as they adopt an RPC (shared contract — coordinate changes, TRD §5).
export const RPC_RESULT_SCHEMAS = {
  bootstrap_account: bootstrapSchema,
  select_context: selectContextResultSchema,
  get_context: contextSchema,
  end_app_session: endSessionSchema,
  record_telemetry: telemetryResultSchema,
  op_list_schools: zod.array(operatorSchoolSchema),
  op_create_school: createSchoolResultSchema,
  op_find_account: foundAccountSchema,
} satisfies Record<string, z.ZodType>;

export type RpcWithSchema = keyof typeof RPC_RESULT_SCHEMAS;
