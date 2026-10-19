import { useEffect, useState } from 'react';
import { useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { canReloadForNewDeploy, isChunkLoadError, reloadForNewDeploy } from '@/lib/stale-deploy';

export function RouteError() {
  const error = useRouteError();
  // A failed lazy chunk after a deploy is the common case: reload once to fetch the new assets
  // (stale-deploy.ts guards against a reload loop; if that reload didn't help, the button remains).
  const chunk = isChunkLoadError(error);
  // decided once, on the first render; the navigation itself happens in the effect
  const [reloading] = useState(() => chunk && canReloadForNewDeploy());
  useEffect(() => {
    if (reloading) reloadForNewDeploy();
  }, [reloading]);

  if (reloading) {
    return (
      <main
        className="mx-auto flex min-h-dvh max-w-md items-center justify-center p-4 text-center"
        role="status"
      >
        <p className="text-muted-foreground text-sm">PrimeCampus was updated — loading the latest version…</p>
      </main>
    );
  }
  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-4 text-center"
      role="alert"
    >
      <h1 className="text-xl font-semibold">{chunk ? 'PrimeCampus was updated' : 'Something went wrong'}</h1>
      <p className="text-muted-foreground text-sm">
        {chunk
          ? 'Reload the page to get the latest version.'
          : 'Reload the page. If this keeps happening, contact support.'}
      </p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </main>
  );
}
