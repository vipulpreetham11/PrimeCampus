import { Link, useLocation, useParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useCan } from '@/lib/scope';
import { useReceipt } from '../hooks';
import { ReceiptView } from './ReceiptView';

/** Staff receipt page (fees.read). Right after a payment it says whether it was new or a replay. */
export function ReceiptPage() {
  const { receiptId } = useParams();
  const query = useReceipt(receiptId);
  const canManage = useCan('fees.manage');
  const state = (useLocation().state ?? {}) as { posted?: boolean; replayed?: boolean };
  return (
    <div className="space-y-4">
      <div className="print:hidden">
        <PageHeader
          title="Receipt"
          actions={
            canManage ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/fees/collect">Collect another payment</Link>
              </Button>
            ) : undefined
          }
        />
        {state.posted && (
          <p role="status" className="mb-3 rounded-md border border-green-700/40 p-3 text-sm" data-testid="posted-notice">
            {state.replayed
              ? 'This payment was already saved — this is its receipt. Nothing was charged twice.'
              : 'Payment saved.'}
          </p>
        )}
      </div>
      <DataState query={query}>
        {(r) => <ReceiptView receipt={r} />}
      </DataState>
    </div>
  );
}

