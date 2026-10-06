import { useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';

export function RouteError() {
  const error = useRouteError();
  // A failed lazy chunk after a deploy is the common case; reloading fetches the new assets.
  const chunk =
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed/i.test(error.message);
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
