import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { toast } from 'sonner';
import { setTelemetryEnabled, trackPageView } from '@/lib/telemetry';
import { useSession } from '@/lib/session/store';
import { redirectFor } from '../gate';

export function RootLayout() {
  const session = useSession();
  const location = useLocation();
  const signedIn = session.status !== 'signed_out' && session.status !== 'loading';

  useEffect(() => setTelemetryEnabled(signedIn), [signedIn]);
  useEffect(() => {
    if (signedIn) trackPageView(location.pathname);
  }, [signedIn, location.pathname]);

  // Notices are shown once, where they can't cover the context header: the shell has a persistent
  // banner (ready) and the sign-in page shows sign-out notices. Only the chooser needs a toast.
  const { notice, status } = session;
  useEffect(() => {
    if (notice?.kind === 'context_changed' && status === 'choosing') {
      toast.info(notice.message, { id: `notice-${notice.id}` });
    }
  }, [notice, status]);

  if (session.status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
        <p className="text-muted-foreground text-sm">Loading PrimeCampus…</p>
      </div>
    );
  }
  const target = redirectFor(session.status, location.pathname, session.account?.isOperator ?? false);
  if (target && target !== location.pathname) return <Navigate to={target} replace />;
  // Keyed by epoch: a context switch or logout unmounts every page, discarding form drafts.
  return <Outlet key={session.epoch} />;
}
