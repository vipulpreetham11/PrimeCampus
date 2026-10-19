import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { MoneyText } from '@/components/shared/MoneyText';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Statement, StatementCollection, StatementInvoice, StudentConcession } from '@/contracts/fees';
import { formatDateTime } from '@/lib/dates';
import { formatBasisPoints } from '@/lib/money';
import { useCan, useCurrentYearId } from '@/lib/scope';
import { useRevokeConcession, useStatement, useStudentConcessions, useWaiveLateFee } from '../hooks';
import {
  AdjustmentDialog,
  CancelInvoiceDialog,
  GrantConcessionDialog,
  OpeningBalanceDialog,
  ReasonActionDialog,
  ReverseDialog,
} from './dialogs';
import { StatementSummary, StatementView, StudentHeading } from './StatementView';

// Staff view of one student's fees (fees.read; actions with fees.manage).

type Open =
  | { kind: 'adjust'; inv: StatementInvoice }
  | { kind: 'waive'; inv: StatementInvoice }
  | { kind: 'cancel'; inv: StatementInvoice }
  | { kind: 'reverse'; col: StatementCollection }
  | { kind: 'grant' }
  | { kind: 'opening' }
  | { kind: 'revoke'; sc: StudentConcession }
  | null;

/** A late fee that has not been waived yet is on the invoice. */
export function hasUnwaivedLateFee(inv: StatementInvoice): boolean {
  const fees = inv.adjustments.filter((a) => a.kind === 'late_fee').length;
  const waived = inv.adjustments.filter((a) => a.kind === 'late_fee_waiver').length;
  return fees > waived;
}

export function StatementPage() {
  const { studentId } = useParams();
  const statement = useStatement(studentId ?? null);
  const canManage = useCan('fees.manage');
  const yearId = useCurrentYearId();
  const [open, setOpen] = useState<Open>(null);
  const { hash } = useLocation();
  const waive = useWaiveLateFee();
  const revoke = useRevokeConcession();

  // "#invoice-<id>" (links from the concession notice) scrolls to that invoice once it is shown
  useEffect(() => {
    if (!hash || !statement.data) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [hash, statement.data]);

  const close = () => setOpen(null);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Fee statement"
        actions={
          canManage && studentId ? (
            <>
              <Button asChild size="sm">
                <Link to={`/fees/collect?student=${studentId}`}>Collect payment</Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen({ kind: 'grant' })}
                disabled={!yearId}
              >
                Grant concession
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen({ kind: 'opening' })}
                disabled={!yearId}
              >
                Add opening balance
              </Button>
            </>
          ) : undefined
        }
      />
      <DataState query={statement}>
        {(st) => (
          <>
            <Card>
              <CardHeader>
                <StudentHeading statement={st} />
              </CardHeader>
              <CardContent>
                <StatementSummary statement={st} />
              </CardContent>
            </Card>
            <StatementView
              statement={st}
              receiptHref={(id) => `/fees/receipts/${id}`}
              invoiceActions={
                canManage
                  ? (inv) =>
                      inv.status === 'issued' ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setOpen({ kind: 'adjust', inv })}
                          >
                            Add adjustment
                          </Button>
                          {hasUnwaivedLateFee(inv) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setOpen({ kind: 'waive', inv })}
                            >
                              Waive late fee
                            </Button>
                          )}
                          {inv.paid_paise === 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setOpen({ kind: 'cancel', inv })}
                            >
                              Cancel invoice
                            </Button>
                          )}
                        </>
                      ) : null
                  : undefined
              }
              collectionActions={
                canManage
                  ? (col) =>
                      col.method !== 'cheque' && col.amount_paise - col.reversed_paise > 0 ? (
                        <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'reverse', col })}>
                          Reverse
                        </Button>
                      ) : col.method === 'cheque' ? (
                        <span className="text-muted-foreground text-xs">
                          A cheque payment is undone by bouncing the cheque.
                        </span>
                      ) : null
                  : undefined
              }
            />
            {studentId && (
              <ConcessionsCard
                studentId={studentId}
                canManage={canManage}
                onRevoke={(sc) => setOpen({ kind: 'revoke', sc })}
              />
            )}
            {open?.kind === 'grant' && studentId && yearId && (
              <GrantConcessionDialog
                studentId={studentId}
                studentName={nameOf(st)}
                yearId={yearId}
                onClose={close}
              />
            )}
          </>
        )}
      </DataState>
      {open?.kind === 'adjust' && <AdjustmentDialog invoice={open.inv} onClose={close} />}
      {open?.kind === 'cancel' && <CancelInvoiceDialog invoice={open.inv} onClose={close} />}
      {open?.kind === 'reverse' && <ReverseDialog collection={open.col} onClose={close} />}
      {open?.kind === 'opening' && studentId && yearId && (
        <OpeningBalanceDialog studentId={studentId} yearId={yearId} onClose={close} />
      )}
      {open?.kind === 'waive' && (
        <ReasonActionDialog
          title={`Waive the late fee on ${open.inv.invoice_no}?`}
          description="The late fee is cancelled by a waiver entry; the history stays visible."
          confirmLabel="Waive late fee"
          onSend={(reason) => waive.mutateAsync({ invoiceId: open.inv.invoice_id, reason })}
          onClose={close}
          successMessage={(r) => (r.replayed ? 'The late fee was already waived.' : 'Late fee waived.')}
        />
      )}
      {open?.kind === 'revoke' && (
        <ReasonActionDialog
          title={`Revoke ${open.sc.preset_name}?`}
          description="Invoices already issued keep this concession; it stops applying to invoices issued from now on."
          confirmLabel="Revoke"
          destructive
          onSend={(reason) => revoke.mutateAsync({ id: open.sc.id, reason })}
          onClose={close}
          successMessage={(r) => (r.replayed ? 'Already revoked.' : 'Concession revoked.')}
        />
      )}
    </div>
  );
}

const nameOf = (st: Statement) => st.student.name;

function ConcessionsCard({
  studentId,
  canManage,
  onRevoke,
}: {
  studentId: string;
  canManage: boolean;
  onRevoke: (sc: StudentConcession) => void;
}) {
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const query = useStudentConcessions({ yearId: null, studentId, includeRevoked });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Concessions</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setIncludeRevoked((v) => !v)}>
          {includeRevoked ? 'Hide revoked' : 'Show revoked'}
        </Button>
      </CardHeader>
      <CardContent>
        <DataState
          query={query}
          isEmpty={(d) => d.pages.every((p) => p.items.length === 0)}
          emptyTitle="No concessions"
        >
          {(d) => (
            <ul className="divide-y rounded-md border text-sm">
              {d.pages
                .flatMap((p) => p.items)
                .map((sc) => (
                  <li
                    key={sc.id}
                    className="flex flex-wrap items-center gap-2 p-3"
                    data-testid={`concession-${sc.preset_name}`}
                  >
                    <span className="font-medium">{sc.preset_name}</span>
                    <span>
                      {sc.kind === 'percent' ? (
                        formatBasisPoints(sc.percent_bp ?? 0)
                      ) : (
                        <MoneyText paise={sc.fixed_paise} />
                      )}
                    </span>
                    <span>{sc.term ? `${sc.term} only` : 'Whole year'}</span>
                    {sc.status === 'revoked' && <Badge variant="outline">Revoked</Badge>}
                    <span className="text-muted-foreground basis-full">
                      {sc.reason} · {sc.granted_by ?? 'Unknown'} · {formatDateTime(sc.granted_at)}
                      {sc.revoke_reason ? ` · revoked: ${sc.revoke_reason}` : ''}
                    </span>
                    {canManage && sc.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => onRevoke(sc)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
