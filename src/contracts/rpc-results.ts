import { z } from 'zod';
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
import {
  attendanceModeSavedSchema,
  calendarRangeSavedSchema,
  calendarSchema,
  classSavedSchema,
  classSubjectSchema,
  countResultSchema,
  scheduleSavedSchema,
  schoolProfileSavedSchema,
  schoolProfileSchema,
  sectionSavedSchema,
  setCurrentYearSchema,
  setupSnapshotSchema,
  subjectSavedSchema,
  yearSavedSchema,
} from './setup';
import {
  staffConfidentialSchema,
  staffFinanceSavedSchema,
  staffGroupSavedSchema,
  staffGroupSchema,
  staffListItemSchema,
  staffRecordSchema,
  staffSavedSchema,
  teachingAssignmentEndedSchema,
  teachingAssignmentSavedSchema,
  teachingAssignmentSchema,
} from './staff';
import {
  admissionsDutySchema,
  disabledMembershipSchema,
  foundSchoolAccountSchema,
  grantedMembershipSchema,
  linkAccountResultSchema,
  schoolUserSchema,
} from './users';
import {
  guardianRecordSchema,
  guardianSavedSchema,
  guardianSearchItemSchema,
  movePlacementsSchema,
  sensitiveSavedSchema,
  studentPageSchema,
  studentProfileSchema,
  studentUpdatedSchema,
} from './students';
import {
  admitResultSchema,
  followupDueSchema,
  followupSavedSchema,
  leadDetailSchema,
  leadPageSchema,
  leadSavedSchema,
} from './admissions';

// Response schemas per RPC. The RPC layer validates a response when its function is listed
// here; otherwise the generated `Json` type is returned. Feature modules add their DTOs here
// as they adopt an RPC (shared contract — coordinate changes, TRD §5).
export const RPC_RESULT_SCHEMAS = {
  // M0 — session / operator
  bootstrap_account: bootstrapSchema,
  select_context: selectContextResultSchema,
  get_context: contextSchema,
  end_app_session: endSessionSchema,
  record_telemetry: telemetryResultSchema,
  op_list_schools: z.array(operatorSchoolSchema),
  op_create_school: createSchoolResultSchema,
  op_find_account: foundAccountSchema,

  // M1 — setup
  get_school_profile: schoolProfileSchema,
  save_school_profile: schoolProfileSavedSchema,
  get_setup_snapshot: setupSnapshotSchema,
  save_academic_year: yearSavedSchema,
  set_current_year: setCurrentYearSchema,
  save_class: classSavedSchema,
  save_section: sectionSavedSchema,
  save_subject: subjectSavedSchema,
  list_class_subjects: z.array(classSubjectSchema),
  save_class_subjects: countResultSchema,
  save_period_schedule: scheduleSavedSchema,
  set_attendance_mode: attendanceModeSavedSchema,
  get_calendar: calendarSchema,
  save_calendar_pattern: countResultSchema,
  save_calendar_range: calendarRangeSavedSchema,

  // M1 — staff
  list_staff_groups: z.array(staffGroupSchema),
  save_staff_group: staffGroupSavedSchema,
  list_staff: z.array(staffListItemSchema),
  get_staff: staffRecordSchema,
  save_staff: staffSavedSchema,
  get_staff_confidential: staffConfidentialSchema,
  save_staff_finance: staffFinanceSavedSchema,
  list_teaching_assignments: z.array(teachingAssignmentSchema),
  save_teaching_assignment: teachingAssignmentSavedSchema,
  end_teaching_assignment: teachingAssignmentEndedSchema,

  // M1 — users
  list_school_users: z.array(schoolUserSchema),
  find_school_account: foundSchoolAccountSchema,
  grant_membership: grantedMembershipSchema,
  set_admissions_duty: admissionsDutySchema,
  disable_membership: disabledMembershipSchema,
  link_account: linkAccountResultSchema,

  // M1 — students & guardians
  list_students: studentPageSchema,
  get_student_profile: studentProfileSchema,
  update_student: studentUpdatedSchema,
  save_student_sensitive: sensitiveSavedSchema,
  get_guardian: guardianRecordSchema,
  search_guardians: z.array(guardianSearchItemSchema),
  save_guardian: guardianSavedSchema,
  move_placements: movePlacementsSchema,

  // M1 — admissions
  list_leads: leadPageSchema,
  get_lead: leadDetailSchema,
  save_lead: leadSavedSchema,
  record_lead_followup: followupSavedSchema,
  get_followups_due: z.array(followupDueSchema),
  admit_student: admitResultSchema,
} satisfies Record<string, z.ZodType>;

export type RpcWithSchema = keyof typeof RPC_RESULT_SCHEMAS;
