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
