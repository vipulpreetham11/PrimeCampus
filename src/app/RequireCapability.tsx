import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { Lock } from 'lucide-react';
import type { Capability } from '@/contracts/capabilities';
import { useSessionSelector } from '@/lib/session/store';

/**
 * Route guard for UX only: shows a clear "no access" page instead of a broken screen when a direct
 * URL is opened without the capability. The server still enforces every RPC (FORBIDDEN).
 */
export function RequireCapability({ anyOf, children }: { anyOf: Capability[]; children?: ReactNode }) {
  const caps = useSessionSelector((s) => s.context?.capabilities ?? []);
  if (!anyOf.some((c) => caps.includes(c))) {
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center"
      >
        <Lock aria-hidden="true" className="text-muted-foreground" />
        <p className="font-medium">You don&apos;t have access to this page</p>
        <p className="text-muted-foreground text-sm">
          Your current role can&apos;t open it. Switch role if you have another one.
        </p>
      </div>
    );
  }
  return <>{children ?? <Outlet />}</>;
}
