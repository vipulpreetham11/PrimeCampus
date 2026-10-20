import { useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FeeStudent, StudentConcession } from '@/contracts/fees';
import { formatDateTime } from '@/lib/dates';
import { formatBasisPoints } from '@/lib/money';
import { useCan, useCurrentYearId } from '@/lib/scope';
import { useRevokeConcession, useStudentConcessions } from '../hooks';
import { StudentPicker, YearSelect } from '../parts';
import { GrantConcessionDialog, ReasonActionDialog } from '../statement/dialogs';

// Concessions for students (brief §2): the year's list, grant (pick a student) and revoke.

export function ConcessionsPage() {
  const canManage = useCan('fees.manage');
  const currentYear = useCurrentYearId();
  const [yearId, setYearId] = useState<string | null>(currentYear);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const query = useStudentConcessions({ yearId, studentId: null, includeRevoked });
  const [granting, setGranting] = useState<FeeStudent | null>(null);
  const [revoking, setRevoking] = useState<StudentConcession | null>(null);
  const revoke = useRevokeConcession();
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Concessions" actions={<YearSelect value={yearId} onChange={setYearId} />} />
      {canManage && yearId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Grant a concession</CardTitle>
          </CardHeader>
          <CardContent>
            <StudentPicker label="Student" onPick={setGranting} />
          </CardContent>
        </Card>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setIncludeRevoked((v) => !v)}>
          {includeRevoked ? 'Hide revoked' : 'Show revoked'}
        </Button>
      </div>
      <DataState query={query} isEmpty={() => rows.length === 0} emptyTitle="No concessions in this year">
        {() => (
          <Card>
            <CardContent className="pt-6">
              <ul className="divide-y rounded-md border text-sm">
                {rows.map((sc) => (
                  <li key={sc.id} className="flex flex-wrap items-center gap-2 p-3">
                    <Link to={`/fees/students/${sc.student_id}`} className="font-medium underline">
                      {sc.name}
                    </Link>
                    <span className="text-muted-foreground break-all">{sc.admission_no}</span>
                    <span>
                      {sc.preset_name} ·{' '}
                      {sc.kind === 'percent' ? (
                        formatBasisPoints(sc.percent_bp ?? 0)
                      ) : (
                        <MoneyText paise={sc.fixed_paise} />
                      )}{' '}
                      · {sc.term ? `${sc.term} only` : 'whole year'}
                    </span>
                    {sc.status === 'revoked' && <Badge variant="outline">Revoked</Badge>}
                    <span className="text-muted-foreground basis-full">
                      {sc.reason} · {sc.granted_by ?? 'Unknown'} · {formatDateTime(sc.granted_at)}
                    </span>
                    {canManage && sc.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => setRevoking(sc)}>
                        Revoke
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
      {granting && yearId && (
        <GrantConcessionDialog
          studentId={granting.student_id}
          studentName={granting.name}
          yearId={yearId}
          onClose={() => setGranting(null)}
        />
      )}
      {revoking && (
        <ReasonActionDialog
          title={`Revoke ${revoking.preset_name} for ${revoking.name}?`}
          description="Invoices already issued keep this concession; it stops applying to invoices issued from now on."
          confirmLabel="Revoke"
          destructive
          onSend={(reason) => revoke.mutateAsync({ id: revoking.id, reason })}
          onClose={() => setRevoking(null)}
          successMessage={(r) => (r.replayed ? 'Already revoked.' : 'Concession revoked.')}
        />
      )}
    </div>
  );
}
