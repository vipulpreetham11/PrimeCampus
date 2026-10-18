import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import type { Capability } from '@/contracts/capabilities';
import { RootLayout } from './layouts/RootLayout';
import { AppShell } from './layouts/AppShell';
import { RequireCapability } from './RequireCapability';
import { RouteError } from './RouteError';

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
  ],
);

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
          childRoutes,
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
