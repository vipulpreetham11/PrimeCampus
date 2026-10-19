import { z } from '@/lib/zod';
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
import {
  commitChunkResultSchema,
  importJobPageSchema,
  importJobSchema,
  importTemplateSchema,
  rowChangeResultSchema,
  stageResultSchema,
  startImportResultSchema,
} from './imports';
import {
  lessonUpdatedSchema,
  lessonsGeneratedSchema,
  scheduleDaySchema,
  scheduleLessonSchema,
  substituteAssignedSchema,
  substituteSuggestionSchema,
  substitutionRowSchema,
  teacherTodaySchema,
  timetableActivatedSchema,
  timetableCopiedSchema,
  timetableDiscardedSchema,
  timetableDraftSavedSchema,
  timetableVersionRowSchema,
  timetableVersionSchema,
} from './timetable';
import {
  attendanceOverviewSchema,
  attendanceRecordSchema,
  attendanceSummarySchema,
  markingRosterSchema,
  staffAttendanceSchema,
  staffMarksSavedSchema,
  studentMarksSavedSchema,
} from './attendance';
import {
  diaryEntrySchema,
  diaryPageSchema,
  diarySavedSchema,
  homeworkChecksSavedSchema,
  homeworkPageSchema,
  homeworkRosterSchema,
  homeworkSavedSchema,
  studentDiaryItemSchema,
  studentHomeworkItemSchema,
} from './academic';

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

  // M1b — spreadsheet imports
  get_import_template: importTemplateSchema,
  start_import: startImportResultSchema,
  stage_import_rows: stageResultSchema,
  get_import_job: importJobPageSchema,
  update_import_row: rowChangeResultSchema,
  set_import_row_removed: rowChangeResultSchema,
  commit_import_chunk: commitChunkResultSchema,
  close_import: importJobSchema,
  list_import_jobs: z.array(importJobSchema),

  // M2 — timetable & lessons
  list_timetable_versions: z.array(timetableVersionRowSchema),
  get_timetable_version: timetableVersionSchema,
  save_timetable_draft: timetableDraftSavedSchema,
  discard_timetable_draft: timetableDiscardedSchema,
  activate_timetable: timetableActivatedSchema,
  copy_timetable: timetableCopiedSchema,
  generate_lesson_sessions: lessonsGeneratedSchema,
  get_date_schedule: z.array(scheduleLessonSchema),
  get_schedule_range: z.array(scheduleDaySchema),
  update_lesson_session: lessonUpdatedSchema,
  suggest_substitutes: z.array(substituteSuggestionSchema),
  assign_substitute: substituteAssignedSchema,
  remove_substitute: lessonUpdatedSchema,
  list_substitutions: z.array(substitutionRowSchema),
  get_teacher_today: teacherTodaySchema,

  // M2 — attendance
  get_marking_roster: markingRosterSchema,
  mark_student_attendance: studentMarksSavedSchema,
  get_attendance_overview: attendanceOverviewSchema,
  get_student_attendance_summary: attendanceSummarySchema,
  get_student_attendance_records: z.array(attendanceRecordSchema),
  get_staff_attendance: staffAttendanceSchema,
  mark_staff_attendance: staffMarksSavedSchema,

  // M2 — diary & homework
  get_diary_entry: diaryEntrySchema,
  save_diary_entry: diarySavedSchema,
  list_diary_entries: diaryPageSchema,
  get_student_diary: z.array(studentDiaryItemSchema),
  save_homework: homeworkSavedSchema,
  list_homework: homeworkPageSchema,
  get_homework_roster: homeworkRosterSchema,
  mark_homework_checks: homeworkChecksSavedSchema,
  get_student_homework: z.array(studentHomeworkItemSchema),
} satisfies Record<string, z.ZodType>;

export type RpcWithSchema = keyof typeof RPC_RESULT_SCHEMAS;
