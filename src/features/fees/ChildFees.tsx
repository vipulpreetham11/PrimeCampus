import { Link, useParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useChildId } from '@/features/child/ChildPages';
import { useReceipt, useStatement } from './hooks';
import { ReceiptView } from './receipts/ReceiptView';
import { StatementSummary, StatementView, StudentHeading } from './statement/StatementView';

// Parent / student area (child.view): the selected child's statement and receipts, read-only.
// The child is always the one in the context, never an id from the URL; the server refuses any other
// child's statement or receipt (FORBIDDEN), which DataState shows as "You don't have access".

export function ChildFeesPage() {
  const childId = useChildId();
  const statement = useStatement(childId);
  return (
    <div className="space-y-4" data-testid="child-fees">
      <PageHeader
        title="Fees"
        description="Dues, payments and receipts. Ask the school office about any difference."
      />
      {!childId ? (
        <p className="text-muted-foreground text-sm">
          Choose a child first (switch role / child in the header).
        </p>
      ) : (
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
              <StatementView statement={st} receiptHref={(id) => `/child/fees/receipts/${id}`} />
            </>
          )}
        </DataState>
      )}
    </div>
  );
}

export function ChildReceiptPage() {
  const { receiptId } = useParams();
  const query = useReceipt(receiptId);
  return (
    <div className="space-y-4">
      <div className="print:hidden">
        <PageHeader title="Receipt" />
        <p className="mb-3 text-sm">
          <Link to="/child/fees" className="underline">
            Back to fees
          </Link>
        </p>
      </div>
      <DataState query={query}>{(r) => <ReceiptView receipt={r} />}</DataState>
    </div>
  );
}
