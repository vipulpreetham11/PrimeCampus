import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import type { Capability } from '@/contracts/capabilities';
import { RootLayout } from './layouts/RootLayout';
import { AppShell } from './layouts/AppShell';
import { RequireCapability } from './RequireCapability';
import { RouteError } from './RouteError';
import { consumeReloadMarker } from '@/lib/stale-deploy';

// Data router with lazy route modules (TRD §3). Route guards improve navigation only;
// the server enforces permissions on every RPC.

/** Wrap routes in a capability guard (UX only). */
function guarded(anyOf: Capability[], children: RouteObject[]): RouteObject {
  return { element: <RequireCapability anyOf={anyOf} />, children };
}

const setupRoutes: RouteObject = guarded(
  ['setup.manage', 'staff.member'],
  [
    {
      path: '/setup',
      lazy: () => import('@/features/setup/SetupLayout').then((m) => ({ Component: m.SetupLayout })),
      children: [
        { index: true, element: <Navigate to="/setup/profile" replace /> },
        {
          path: 'profile',
          lazy: () =>
            import('@/features/setup/SchoolProfilePage').then((m) => ({ Component: m.SchoolProfilePage })),
        },
        {
          path: 'years',
          lazy: () => import('@/features/setup/YearsPage').then((m) => ({ Component: m.YearsPage })),
        },
        {
          path: 'classes',
          lazy: () => import('@/features/setup/ClassesPage').then((m) => ({ Component: m.ClassesPage })),
        },
        {
          path: 'subjects',
          lazy: () => import('@/features/setup/SubjectsPage').then((m) => ({ Component: m.SubjectsPage })),
        },
        {
          path: 'bell-schedules',
          lazy: () =>
            import('@/features/setup/BellSchedulesPage').then((m) => ({ Component: m.BellSchedulesPage })),
        },
        {
          path: 'attendance-mode',
          lazy: () =>
            import('@/features/setup/AttendanceModePage').then((m) => ({ Component: m.AttendanceModePage })),
        },
        {
          path: 'calendar',
          lazy: () => import('@/features/setup/CalendarPage').then((m) => ({ Component: m.CalendarPage })),
        },
      ],
    },
  ],
);

const staffRoutes: RouteObject = guarded(
  ['staff.read'],
  [
    {
      path: '/staff',
      lazy: () => import('@/features/staff/StaffLayout').then((m) => ({ Component: m.StaffLayout })),
      children: [
        {
          index: true,
          lazy: () =>
            import('@/features/staff/StaffDirectoryPage').then((m) => ({ Component: m.StaffDirectoryPage })),
        },
        {
          path: 'groups',
          lazy: () =>
            import('@/features/staff/StaffGroupsPage').then((m) => ({ Component: m.StaffGroupsPage })),
        },
        {
          path: 'teaching',
          lazy: () =>
            import('@/features/staff/TeachingBySectionPage').then((m) => ({
              Component: m.TeachingBySectionPage,
            })),
        },
      ],
    },
    {
      path: '/staff/:staffId',
      lazy: () =>
        import('@/features/staff/StaffProfilePage').then((m) => ({ Component: m.StaffProfilePage })),
    },
  ],
);

const studentRoutes: RouteObject = guarded(
  ['students.read_all'],
  [
    {
      path: '/students',
      lazy: () =>
        import('@/features/students/StudentDirectoryPage').then((m) => ({
          Component: m.StudentDirectoryPage,
        })),
    },
    {
      path: '/students/:studentId',
      lazy: () =>
        import('@/features/students/StudentProfilePage').then((m) => ({ Component: m.StudentProfilePage })),
    },
  ],
);

const admissionRoutes: RouteObject = guarded(
  ['admissions.manage'],
  [
    {
      path: '/admissions',
      lazy: () => import('@/features/admissions/EnquiriesPage').then((m) => ({ Component: m.EnquiriesPage })),
    },
    {
      path: '/admissions/admit',
      lazy: () => import('@/features/admissions/AdmitPage').then((m) => ({ Component: m.AdmitPage })),
    },
    {
      path: '/admissions/:leadId',
      lazy: () =>
        import('@/features/admissions/LeadDetailPage').then((m) => ({ Component: m.LeadDetailPage })),
    },
  ],
);

const userRoutes: RouteObject = guarded(
  ['users.manage'],
  [
    {
      path: '/users',
      lazy: () => import('@/features/users/UsersPage').then((m) => ({ Component: m.UsersPage })),
    },
  ],
);

const importRoutes: RouteObject = guarded(
  ['imports.manage'],
  [
    {
      path: '/imports',
      lazy: () => import('@/features/imports/ImportsPage').then((m) => ({ Component: m.ImportsPage })),
    },
    {
      path: '/imports/new',
      lazy: () => import('@/features/imports/NewImportPage').then((m) => ({ Component: m.NewImportPage })),
    },
    {
      path: '/imports/:jobId',
      lazy: () => import('@/features/imports/ImportJobPage').then((m) => ({ Component: m.ImportJobPage })),
    },
  ],
);

const timetableRoutes: RouteObject = guarded(
  ['timetable.read_all'],
  [
    {
      path: '/timetable',
      lazy: () => import('@/features/timetable/TimetablePage').then((m) => ({ Component: m.TimetablePage })),
    },
    {
      path: '/timetable/:versionId',
      lazy: () =>
        import('@/features/timetable/TimetableEditorPage').then((m) => ({
          Component: m.TimetableEditorPage,
        })),
    },
    {
      path: '/schedule',
      lazy: () => import('@/features/schedule/SchedulePage').then((m) => ({ Component: m.SchedulePage })),
    },
    {
      path: '/schedule/substitutions',
      lazy: () =>
        import('@/features/schedule/SubstitutionsPage').then((m) => ({ Component: m.SubstitutionsPage })),
    },
  ],
);

const lessonsToolRoutes: RouteObject = guarded(
  ['timetable.manage'],
  [
    {
      path: '/timetable/lessons',
      lazy: () =>
        import('@/features/timetable/LessonsToolPage').then((m) => ({ Component: m.LessonsToolPage })),
    },
  ],
);

const teacherRoutes: RouteObject = guarded(
  ['lessons.teach'],
  [
    {
      path: '/today',
      lazy: () =>
        import('@/features/teacher/TeacherTodayPage').then((m) => ({ Component: m.TeacherTodayPage })),
    },
  ],
);

// Rosters and lesson pages: teachers (their own lessons/sections) and academic staff. The server
// decides per lesson/section (FORBIDDEN is shown) and reports can_mark / can_edit.
const academicRoutes: RouteObject = guarded(
  ['lessons.teach', 'attendance.read_all', 'academic.read_all'],
  [
    {
      path: '/attendance/lesson/:lessonId',
      lazy: () =>
        import('@/features/attendance/MarkingRosterPage').then((m) => ({ Component: m.MarkingRosterPage })),
    },
    {
      path: '/attendance/daily/:sectionId/:date',
      lazy: () =>
        import('@/features/attendance/MarkingRosterPage').then((m) => ({ Component: m.MarkingRosterPage })),
    },
    {
      path: '/lessons/:lessonId',
      lazy: () => import('@/features/diary/LessonPage').then((m) => ({ Component: m.LessonPage })),
    },
    {
      path: '/diary',
      lazy: () => import('@/features/diary/DiaryListPage').then((m) => ({ Component: m.DiaryListPage })),
    },
    {
      path: '/homework',
      lazy: () =>
        import('@/features/homework/HomeworkListPage').then((m) => ({ Component: m.HomeworkListPage })),
    },
    {
      path: '/homework/:assignmentId',
      lazy: () =>
        import('@/features/homework/HomeworkRosterPage').then((m) => ({ Component: m.HomeworkRosterPage })),
    },
  ],
);

const attendanceOverviewRoutes: RouteObject = guarded(
  ['attendance.summary'],
  [
    {
      path: '/attendance',
      lazy: () =>
        import('@/features/attendance/AttendanceOverviewPage').then((m) => ({
          Component: m.AttendanceOverviewPage,
        })),
    },
  ],
);

// M4 reports: the register is also open to class teachers (lessons.teach; the server decides
// which sections), the change trail has a student and a staff tab.
const reportRoutes: RouteObject = {
  children: [
    guarded(
      ['attendance.read_all', 'lessons.teach'],
      [
        {
          path: '/attendance/register',
          lazy: () =>
            import('@/features/attendance/register/RegisterPage').then((m) => ({
              Component: m.RegisterPage,
            })),
        },
      ],
    ),
    guarded(
      ['attendance.read_all', 'staff_attendance.read'],
      [
        {
          path: '/attendance/changes',
          lazy: () =>
            import('@/features/attendance/register/ChangesPage').then((m) => ({
              Component: m.AttendanceChangesPage,
            })),
        },
      ],
    ),
    guarded(
      ['academic.read_all'],
      [
        {
          path: '/reports/coverage',
          lazy: () => import('@/features/reports/CoveragePage').then((m) => ({ Component: m.CoveragePage })),
        },
      ],
    ),
  ],
};

// Salary (M4): confidential, staff_finance.read; the calculator's actions need staff_finance.manage.
const salaryRoutes: RouteObject = guarded(
  ['staff_finance.read'],
  [
    {
      path: '/salary',
      lazy: () => import('@/features/salary/SalaryMonthPage').then((m) => ({ Component: m.SalaryMonthPage })),
    },
    {
      path: '/salary/:staffId',
      lazy: () => import('@/features/salary/SalaryStaffPage').then((m) => ({ Component: m.SalaryStaffPage })),
    },
  ],
);

const staffAttendanceRoutes: RouteObject = guarded(
  ['staff_attendance.read'],
  [
    {
      path: '/staff-attendance',
      lazy: () =>
        import('@/features/staff-attendance/StaffAttendancePage').then((m) => ({
          Component: m.StaffAttendancePage,
        })),
    },
  ],
);

// Fees (M3): every fee page needs fees.read; collecting and invoicing need fees.manage.
const feeRoutes: RouteObject = guarded(
  ['fees.read'],
  [
    {
      lazy: () => import('@/features/fees/parts').then((m) => ({ Component: m.FeesLayout })),
      children: [
        {
          path: '/fees',
          lazy: () => import('@/features/fees/parts').then((m) => ({ Component: m.FeesIndex })),
        },
        guarded(
          ['fees.manage'],
          [
            {
              path: '/fees/collect',
              lazy: () =>
                import('@/features/fees/collect/CollectPage').then((m) => ({ Component: m.CollectPage })),
            },
            {
              path: '/fees/invoices',
              lazy: () =>
                import('@/features/fees/invoices/InvoicesPage').then((m) => ({ Component: m.InvoicesPage })),
            },
          ],
        ),
        {
          path: '/fees/students/:studentId',
          lazy: () =>
            import('@/features/fees/statement/StatementPage').then((m) => ({ Component: m.StatementPage })),
        },
        {
          path: '/fees/receipts/:receiptId',
          lazy: () =>
            import('@/features/fees/receipts/ReceiptPage').then((m) => ({ Component: m.ReceiptPage })),
        },
        {
          path: '/fees/cheques',
          lazy: () =>
            import('@/features/fees/corrections/ChequesPage').then((m) => ({ Component: m.ChequesPage })),
        },
        {
          path: '/fees/exceptions',
          lazy: () =>
            import('@/features/fees/corrections/ExceptionsPage').then((m) => ({
              Component: m.ExceptionsPage,
            })),
        },
        {
          path: '/fees/concessions',
          lazy: () =>
            import('@/features/fees/corrections/ConcessionsPage').then((m) => ({
              Component: m.ConcessionsPage,
            })),
        },
        {
          path: '/fees/day-book',
          lazy: () =>
            import('@/features/fees/reports/DayBookPage').then((m) => ({ Component: m.DayBookPage })),
        },
        {
          path: '/fees/reports',
          lazy: () =>
            import('@/features/fees/reports/CollectionReportPage').then((m) => ({
              Component: m.CollectionReportPage,
            })),
        },
        {
          path: '/fees/reports/heads',
          lazy: () => import('@/features/reports/FeeHeadsPage').then((m) => ({ Component: m.FeeHeadsPage })),
        },
        {
          path: '/fees/dues',
          lazy: () => import('@/features/fees/reports/DuesPage').then((m) => ({ Component: m.DuesPage })),
        },
        {
          path: '/fees/setup',
          lazy: () =>
            import('@/features/fees/setup/FeeSetupPage').then((m) => ({ Component: m.FeeSetupPage })),
        },
      ],
    },
  ],
);

const childRoutes: RouteObject = guarded(
  ['child.view'],
  [
    { path: '/child', element: <Navigate to="/dashboard" replace /> },
    {
      path: '/child/timetable',
      lazy: () => import('@/features/child/ChildPages').then((m) => ({ Component: m.ChildTimetablePage })),
    },
    {
      path: '/child/attendance',
      lazy: () => import('@/features/child/ChildPages').then((m) => ({ Component: m.ChildAttendancePage })),
    },
    {
      path: '/child/diary',
      lazy: () => import('@/features/child/ChildPages').then((m) => ({ Component: m.ChildDiaryPage })),
    },
    {
      path: '/child/homework',
      lazy: () => import('@/features/child/ChildPages').then((m) => ({ Component: m.ChildHomeworkPage })),
    },
    {
      path: '/child/fees',
      lazy: () => import('@/features/fees/ChildFees').then((m) => ({ Component: m.ChildFeesPage })),
    },
    {
      path: '/child/fees/receipts/:receiptId',
      lazy: () => import('@/features/fees/ChildFees').then((m) => ({ Component: m.ChildReceiptPage })),
    },
  ],
);

// before the router reads the URL: drop the stale-deploy reload marker (lib/stale-deploy.ts)
consumeReloadMarker();

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      {
        path: '/sign-in',
        lazy: () => import('@/features/auth/SignInPage').then((m) => ({ Component: m.SignInPage })),
      },
      {
        path: '/change-password',
        lazy: () =>
          import('@/features/auth/ChangePasswordPage').then((m) => ({ Component: m.ChangePasswordPage })),
      },
      {
        path: '/choose',
        lazy: () =>
          import('@/features/auth/ContextChooserPage').then((m) => ({ Component: m.ContextChooserPage })),
      },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          {
            path: '/dashboard',
            lazy: () =>
              import('@/features/dashboard/DashboardPage').then((m) => ({ Component: m.DashboardPage })),
          },
          setupRoutes,
          staffRoutes,
          studentRoutes,
          admissionRoutes,
          userRoutes,
          importRoutes,
          lessonsToolRoutes,
          timetableRoutes,
          teacherRoutes,
          academicRoutes,
          attendanceOverviewRoutes,
          staffAttendanceRoutes,
          reportRoutes,
          salaryRoutes,
          childRoutes,
          feeRoutes,
          {
            path: '/operator/activity',
            lazy: () =>
              import('@/features/operator/ConsolePages').then((m) => ({ Component: m.ActivityLogPage })),
          },
          {
            path: '/operator/sign-ins',
            lazy: () =>
              import('@/features/operator/ConsolePages').then((m) => ({ Component: m.SignInsPage })),
          },
          {
            path: '/operator/usage',
            lazy: () => import('@/features/operator/ConsolePages').then((m) => ({ Component: m.UsagePage })),
          },
          {
            path: '/operator/maintenance',
            lazy: () =>
              import('@/features/operator/ConsolePages').then((m) => ({ Component: m.MaintenancePage })),
          },
          {
            path: '/operator/onboarding',
            lazy: () =>
              import('@/features/operator/OnboardingPage').then((m) => ({
                Component: m.OperatorOnboardingPage,
              })),
          },
          {
            path: '*',
            lazy: () => import('./NotFoundPage').then((m) => ({ Component: m.NotFoundPage })),
          },
        ],
      },
    ],
  },
]);
