import type { ReactNode } from 'react';
import { CloudOff, Inbox, Lock, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isAppError, safeMessage } from '@/lib/errors';

// One component for the six distinct states (CLAUDE.md rule 8): loading, empty, error, forbidden,
// offline and data. A failure must never render like "nothing" or "zero".

export interface QueryLike<T> {
  status: 'pending' | 'error' | 'success';
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  data: T | undefined;
  error: unknown;
  refetch?: () => unknown;
}

interface DataStateProps<T> {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  /** Return true when the loaded data is genuinely empty. */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  skeleton?: ReactNode;
}

function Panel({
  icon,
  title,
  children,
  role,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center"
    >
      <span aria-hidden="true" className="text-muted-foreground">
        {icon}
      </span>
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

export function DefaultSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

export function DataState<T>({
  query,
  children,
  isEmpty,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  skeleton,
}: DataStateProps<T>) {
  const offline =
    query.fetchStatus === 'paused' || (isAppError(query.error) && query.error.code === 'NETWORK');

  if (query.status === 'pending') {
    if (offline) {
      return (
        <Panel icon={<CloudOff />} title="You are offline" role="status">
          <p className="text-muted-foreground text-sm">This will load when your connection is back.</p>
        </Panel>
      );
    }
    return <>{skeleton ?? <DefaultSkeleton />}</>;
  }

  if (query.status === 'error') {
    const err = query.error;
    if (isAppError(err) && err.code === 'FORBIDDEN') {
      return (
        <Panel icon={<Lock />} title="You don't have access to this" role="alert">
          <p className="text-muted-foreground text-sm">{err.message || safeMessage('FORBIDDEN')}</p>
        </Panel>
      );
    }
    return (
      <Panel
        icon={offline ? <CloudOff /> : <TriangleAlert />}
        title={offline ? 'You are offline' : 'Could not load this'}
        role="alert"
      >
        <p className="text-muted-foreground text-sm">
          {offline ? safeMessage('NETWORK') : isAppError(err) ? err.message : safeMessage('UNKNOWN')}
        </p>
        {isAppError(err) && !offline && (
          <p className="text-muted-foreground text-xs">
            Request ID: <span className="font-mono select-all">{err.requestId}</span>
          </p>
        )}
        {query.refetch && (
          <Button variant="outline" size="sm" onClick={() => void query.refetch?.()}>
            Try again
          </Button>
        )}
      </Panel>
    );
  }

  const data = query.data as T;
  if (isEmpty?.(data)) {
    return (
      <Panel icon={<Inbox />} title={emptyTitle} role="status">
        {emptyDescription && <div className="text-muted-foreground text-sm">{emptyDescription}</div>}
      </Panel>
    );
  }
  return <>{children(data)}</>;
}
