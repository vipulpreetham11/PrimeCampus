import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MoneyText } from '@/components/shared/MoneyText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Statement, StatementCollection, StatementInvoice } from '@/contracts/fees';
import { formatDate, formatDateTime } from '@/lib/dates';
import { adjustmentLabel, invoiceSourceLabel, methodLabel, reversalCauseLabel } from '../labels';
import { Figure, OverdueBadge, PaymentStateBadge } from '../parts';

// Student fee statement (brief §6), shared by staff (fees.read) and the parent/student area
// (child.view, read-only). Every amount comes from a loaded statement — the caller renders this only
// inside DataState, so loading / failed / offline never look like "₹0 due" or "Paid".

/** Student name, admission number and class (statement.student, migration 2320). */
export function StudentHeading({ statement }: { statement: Statement }) {
  const s = statement.student;
  if (!s) return <CardTitle className="text-base">Student fee statement</CardTitle>;
  return (
    <div className="min-w-0">
      <CardTitle className="text-base" data-testid="statement-student">
        {s.name}
      </CardTitle>
      <p className="text-muted-foreground text-sm break-all">
        {s.admission_no} · {s.class_section ?? 'Class not set'}
        {s.status !== 'active' ? ` · ${s.status}` : ''}
      </p>
    </div>
  );
}

export function StatementSummary({ statement }: { statement: Statement }) {
  const pending = statement.pending_cheques.reduce((s, c) => s + c.amount_paise, 0);
  const overdue = statement.invoices.filter((i) => i.overdue).reduce((s, i) => s + i.balance_paise, 0);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Figure label="Total due" testId="total-due">
        <MoneyText paise={statement.total_due_paise} />
      </Figure>
      <Figure label="Overdue" testId="total-overdue">
        <MoneyText paise={overdue} />
      </Figure>
      <Figure label="Pending cheques (not counted as paid)" testId="pending-cheques-total">
        {statement.pending_cheques.length === 0 ? 'None' : <MoneyText paise={pending} />}
      </Figure>
      <Figure label="Open payment exceptions">{statement.open_exceptions}</Figure>
    </dl>
  );
}

function InvoiceCard({ inv, actions }: { inv: StatementInvoice; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li id={`invoice-${inv.invoice_id}`} className="space-y-2 p-3" data-testid={`invoice-${inv.invoice_no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{inv.term ?? inv.origin_label ?? invoiceSourceLabel(inv.source)}</span>
        <span className="text-muted-foreground text-sm break-all">{inv.invoice_no}</span>
        <PaymentStateBadge state={inv.payment_state} />
        {inv.overdue && <OverdueBadge />}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <Figure label="Due date">{formatDate(inv.due_date)}</Figure>
        <Figure label="Charged">
          <MoneyText paise={inv.charged_paise} />
        </Figure>
        <Figure label="Adjustments">
          <MoneyText paise={inv.adjustments_paise} />
        </Figure>
        <Figure label="Paid">
          <MoneyText paise={inv.paid_paise} />
        </Figure>
        <Figure label="Balance" testId="invoice-balance">
          <MoneyText paise={inv.balance_paise} />
        </Figure>
      </dl>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-8"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="size-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4" aria-hidden="true" />
        )}
        Details
      </Button>
      {open && (
        <div className="space-y-2 text-sm">
          <table className="w-full text-left">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="py-1 font-normal">Fee</th>
                <th className="py-1 text-right font-normal">Amount</th>
                <th className="py-1 text-right font-normal">Concession</th>
                <th className="py-1 text-right font-normal">Net</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1">{l.label}</td>
                  <td className="py-1 text-right">
                    <MoneyText paise={l.gross_paise} />
                  </td>
                  <td className="py-1 text-right">
                    {l.concession_paise > 0 ? <MoneyText paise={l.concession_paise} /> : 'None'}
                  </td>
                  <td className="py-1 text-right">
                    <MoneyText paise={l.net_paise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {inv.adjustments.length > 0 && (
            <ul className="space-y-1" aria-label="Adjustments">
              {inv.adjustments.map((a, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{adjustmentLabel(a.kind)}</span>
                  <MoneyText paise={a.amount_paise} />
                  <span className="text-muted-foreground">
                    {a.reason ? `— ${a.reason}` : ''} · {formatDateTime(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}

function CollectionItem({
  c,
  receiptHref,
  actions,
}: {
  c: StatementCollection;
  receiptHref: (receiptId: string) => string;
  actions?: ReactNode;
}) {
  return (
    <li className="space-y-1 p-3 text-sm" data-testid={`payment-${c.receipt_no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link to={receiptHref(c.receipt_id)} className="font-medium underline">
          {c.receipt_no}
        </Link>
        <span>{formatDate(c.received_on)}</span>
        <span>{methodLabel(c.method)}</span>
        <MoneyText paise={c.amount_paise} className="font-medium" />
        {c.reversed_paise > 0 && (
          <Badge variant="outline">
            {c.reversed_paise >= c.amount_paise ? 'Fully reversed' : 'Partly reversed'}
          </Badge>
        )}
      </div>
      {c.reference && <p className="text-muted-foreground break-all">Reference: {c.reference}</p>}
      {c.allocations.length > 0 && (
        <p>
          Went to:{' '}
          {c.allocations.map((a, i) => (
            <span key={a.invoice_id}>
              {i > 0 && ', '}
              {a.invoice_no} <MoneyText paise={a.amount_paise} />
            </span>
          ))}
        </p>
      )}
      {c.reversals.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5">
          {c.reversals.map((r, i) => (
            <li key={i}>
              {reversalCauseLabel(r.cause)}: <MoneyText paise={r.amount_paise} />
              {r.reason ? ` — ${r.reason}` : ''} · {formatDateTime(r.at)}
            </li>
          ))}
        </ul>
      )}
      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </li>
  );
}

export function StatementView({
  statement,
  receiptHref,
  invoiceActions,
  collectionActions,
}: {
  statement: Statement;
  receiptHref: (receiptId: string) => string;
  invoiceActions?: (inv: StatementInvoice) => ReactNode;
  collectionActions?: (c: StatementCollection) => ReactNode;
}) {
  const invoices = statement.invoices;
  return (
    <div className="space-y-4" data-testid="statement">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              No invoices yet. Nothing has been charged to this student.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {invoices.map((inv) => (
                <InvoiceCard key={inv.invoice_id} inv={inv} actions={invoiceActions?.(inv)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {statement.collections.length === 0 ? (
            <p className="text-muted-foreground text-sm" role="status">
              No payments recorded.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {[...statement.collections].reverse().map((c) => (
                <CollectionItem
                  key={c.collection_id}
                  c={c}
                  receiptHref={receiptHref}
                  actions={collectionActions?.(c)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {(statement.pending_cheques.length > 0 || statement.bounced_cheques.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cheques</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {statement.pending_cheques.map((ch) => (
              <div
                key={ch.cheque_id}
                className="rounded-md border p-3"
                data-testid={`pending-cheque-${ch.cheque_no}`}
              >
                <p>
                  <span className="font-medium">Cheque {ch.cheque_no}</span> · {ch.bank_name} ·{' '}
                  <MoneyText paise={ch.amount_paise} /> · received {formatDate(ch.received_on)}
                </p>
                <p>
                  <Badge variant="outline">Pending — not counted as paid</Badge>
                </p>
                {ch.planned_allocations && ch.planned_allocations.length > 0 && (
                  <p className="text-muted-foreground">
                    Planned for:{' '}
                    {ch.planned_allocations.map((a, i) => (
                      <span key={a.invoice_id}>
                        {i > 0 && ', '}
                        {a.invoice_no} <MoneyText paise={a.amount_paise} />
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
            {statement.bounced_cheques.map((ch) => (
              <div
                key={ch.cheque_id}
                className="rounded-md border p-3"
                data-testid={`bounced-cheque-${ch.cheque_no}`}
              >
                <p>
                  <span className="font-medium">Cheque {ch.cheque_no}</span> ·{' '}
                  <MoneyText paise={ch.amount_paise} />
                </p>
                <p>
                  <Badge variant="destructive">Bounced</Badge>{' '}
                  {ch.bounced_on ? formatDate(ch.bounced_on) : ''}
                  {ch.reason ? ` — ${ch.reason}` : ''}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
