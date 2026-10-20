import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ExceptionRow } from '@/contracts/fees';
import { formatDateTime } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { ExceptionDialog } from '../collect/ExceptionDialog';
import { useExceptions, useResolveException } from '../hooks';
import { exceptionKindLabel } from '../labels';

// Payment exceptions (brief §7, AC-25): money recorded but never credited to dues, until resolved
// (refund, later use) with a note. Resolve uses the row version.

export function ExceptionsPage() {
  const canManage = useCan('fees.manage');
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const query = useExceptions(status === 'all' ? null : status);
  const [resolving, setResolving] = useState<ExceptionRow | null>(null);
  const [recording, setRecording] = useState(false);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Payment exceptions"
        description="Over-payments and money nobody can match yet. They never reduce any dues."
        actions={
          canManage && (
            <Button size="sm" variant="outline" onClick={() => setRecording(true)}>
              Record unidentified money
            </Button>
          )
        }
      />
      <div className="space-y-1 sm:w-60">
        <Label htmlFor="exc-status">Show</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger id="exc-status" className="w-full" aria-label="Show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DataState query={query} isEmpty={() => rows.length === 0} emptyTitle="No payment exceptions">
        {() => (
          <Card>
            <CardContent className="pt-6">
              <ul className="divide-y rounded-md border text-sm" data-testid="exception-rows">
                {rows.map((e) => (
                  <li key={e.id} className="space-y-1 p-3" data-testid={`exception-${e.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{exceptionKindLabel(e.kind)}</span>
                      <MoneyText paise={e.amount_paise} className="font-medium" />
                      <Badge variant={e.status === 'open' ? 'default' : 'secondary'}>
                        {e.status === 'open' ? 'Open' : 'Resolved'}
                      </Badge>
                      {e.student_id && (
                        <Link to={`/fees/students/${e.student_id}`} className="underline">
                          {e.name}
                        </Link>
                      )}
                    </div>
                    <p>{e.note}</p>
                    <p className="text-muted-foreground">
                      {e.reference ? `Ref ${e.reference} · ` : ''}
                      {e.receipt_no ? `With receipt ${e.receipt_no} · ` : ''}
                      {e.created_by ?? 'Unknown'} · {formatDateTime(e.created_at)}
                    </p>
                    {e.status === 'resolved' && (
                      <p>
                        Resolved: {e.resolution_note} ({e.resolved_by ?? 'Unknown'}
                        {e.resolved_at ? `, ${formatDateTime(e.resolved_at)}` : ''})
                      </p>
                    )}
                    {canManage && e.status === 'open' && (
                      <Button size="sm" variant="outline" onClick={() => setResolving(e)}>
                        Resolve
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </DataState>
      {resolving && (
        <ResolveDialog
          key={`${resolving.id}-${resolving.version}`}
          row={resolving}
          onClose={() => setResolving(null)}
          onReload={() => void query.refetch()}
        />
      )}
      {recording && (
        <ExceptionDialog open onOpenChange={setRecording} studentId={null} initialAmount={null} />
      )}
    </div>
  );
}

function ResolveDialog({
  row,
  onClose,
  onReload,
}: {
  row: ExceptionRow;
  onClose: () => void;
  onReload: () => void;
}) {
  const mut = useResolveException();
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && !mut.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Resolve this exception</DialogTitle>
          <DialogDescription>
            Say what was done with the money (refunded, used for another student, …).
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (note.trim() === '') return;
            setError(null);
            mut
              .mutateAsync({ id: row.id, note: note.trim(), version: row.version })
              .then(() => {
                toast.success('Exception resolved.');
                onClose();
              })
              .catch((err: unknown) => setError(handleSaveError(err, { reload: onReload })));
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="resolve-note">How it was resolved</Label>
            <Textarea
              id="resolve-note"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
            />
            {touched && note.trim() === '' && (
              <p className="text-destructive text-sm">Describe how it was resolved</p>
            )}
          </div>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={mut.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mut.isPending}>
              {mut.isPending ? 'Saving…' : 'Resolve'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
