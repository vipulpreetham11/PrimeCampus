import { createBrowserRouter, Navigate } from 'react-router';
import { RootLayout } from './layouts/RootLayout';
import { AppShell } from './layouts/AppShell';
import { RouteError } from './RouteError';

// Data router with lazy route modules (TRD §3). Route guards improve navigation only;
// the server enforces permissions on every RPC.
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
          {
            path: '/setup',
            lazy: () => import('@/features/setup/SetupLayout').then((m) => ({ Component: m.SetupLayout })),
            children: [
              { index: true, element: <Navigate to="/setup/profile" replace /> },
              {
                path: 'profile',
                lazy: () =>
                  import('@/features/setup/SchoolProfilePage').then((m) => ({
                    Component: m.SchoolProfilePage,
                  })),
              },
              {
                path: 'years',
                lazy: () => import('@/features/setup/YearsPage').then((m) => ({ Component: m.YearsPage })),
              },
              {
                path: 'classes',
                lazy: () =>
                  import('@/features/setup/ClassesPage').then((m) => ({ Component: m.ClassesPage })),
              },
              {
                path: 'subjects',
                lazy: () =>
                  import('@/features/setup/SubjectsPage').then((m) => ({ Component: m.SubjectsPage })),
              },
              {
                path: 'bell-schedules',
                lazy: () =>
                  import('@/features/setup/BellSchedulesPage').then((m) => ({
                    Component: m.BellSchedulesPage,
                  })),
              },
              {
                path: 'attendance-mode',
                lazy: () =>
                  import('@/features/setup/AttendanceModePage').then((m) => ({
                    Component: m.AttendanceModePage,
                  })),
              },
              {
                path: 'calendar',
                lazy: () =>
                  import('@/features/setup/CalendarPage').then((m) => ({ Component: m.CalendarPage })),
              },
            ],
          },
          {
            path: '/staff',
            lazy: () => import('@/features/staff/StaffLayout').then((m) => ({ Component: m.StaffLayout })),
            children: [
              {
                index: true,
                lazy: () =>
                  import('@/features/staff/StaffDirectoryPage').then((m) => ({
                    Component: m.StaffDirectoryPage,
                  })),
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
              import('@/features/students/StudentProfilePage').then((m) => ({
                Component: m.StudentProfilePage,
              })),
          },
          {
            path: '/users',
            lazy: () => import('@/features/users/UsersPage').then((m) => ({ Component: m.UsersPage })),
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
