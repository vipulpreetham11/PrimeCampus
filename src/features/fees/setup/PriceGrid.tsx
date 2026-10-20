import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FeeHead, FeeSetup } from '@/contracts/fees';
import type { ClassRow } from '@/contracts/setup';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { toAppError, type AppError } from '@/lib/errors';
import { formatPaise, paiseToRupeesString, parseRupees } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useSaveFeeStructure } from '../hooks';

// Price list (brief §1): classes × fee heads for one term. An EMPTY cell is "No price" — the head is
// left out of save_fee_structure — and looks different from an explicit ₹0. Saved one class at a time.

export type CellTexts = Record<string, string>;

export interface RowLines {
  lines: { fee_head_id: string; amount_paise: number }[];
  errors: Record<string, string>;
}

/** Cell texts → the lines to send. Blank = no price (left out); "0" = a ₹0 price. Unit-tested. */
export function priceLines(heads: FeeHead[], texts: CellTexts): RowLines {
  const lines: RowLines['lines'] = [];
  const errors: Record<string, string> = {};
  for (const h of heads) {
    const t = (texts[h.id] ?? '').trim();
    if (t === '') continue;
    const r = parseRupees(t, { allowZero: true });
    if (!r.ok) errors[h.id] = r.error;
    else if (r.paise > 10_000_000_000) errors[h.id] = 'At most ₹10,00,00,000';
    else lines.push({ fee_head_id: h.id, amount_paise: r.paise });
  }
  return { lines, errors };
}

function savedTexts(setup: FeeSetup, termId: string, classId: string): CellTexts {
  const out: CellTexts = {};
  for (const l of setup.structure) {
    if (l.fee_term_id === termId && l.class_id === classId)
      out[l.fee_head_id] = paiseToRupeesString(l.amount_paise);
  }
  return out;
}

function readOnlyPrice(t: string): string {
  const r = parseRupees(t, { allowZero: true });
  return r.ok ? formatPaise(r.paise) : t;
}

const sameTexts = (a: CellTexts, b: CellTexts, heads: FeeHead[]) =>
  heads.every((h) => (a[h.id] ?? '').trim() === (b[h.id] ?? '').trim());

export function PriceGrid({
  setup,
  yearId,
  canManage,
}: {
  setup: FeeSetup;
  yearId: string | null;
  canManage: boolean;
}) {
  const snapshot = useSetupSnapshot(yearId);
  const terms = setup.terms.filter((t) => t.status === 'active');
  const [termId, setTermId] = useState<string | null>(null);
  const term = terms.find((t) => t.id === termId) ?? terms[0] ?? null;
  const heads = setup.fee_heads.filter((h) => h.status === 'active' && h.kind !== 'late_fee');
  const classes = (snapshot.data?.classes ?? []).filter((c) => c.status === 'active');

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Price list</CardTitle>
        {terms.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="price-term">Term</Label>
            <Select value={term?.id ?? ''} onValueChange={setTermId}>
              <SelectTrigger id="price-term" className="w-full sm:w-60" aria-label="Term">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {terms.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <p className="text-muted-foreground text-sm" data-testid="price-legend">
          An empty cell means <strong>No price</strong>: that fee is not charged to the class. Type 0 for a ₹0
          price. Note: a regular fee priced for some classes of a term but left empty for another class makes
          that class&apos;s students wait (they are skipped when invoices are issued) until a price is set.
        </p>
      </CardHeader>
      <CardContent>
        {!term ? (
          <p className="text-sm">Create an active term first (Terms tab).</p>
        ) : heads.length === 0 ? (
          <p className="text-sm">Create fee heads first.</p>
        ) : snapshot.isPending ? (
          <p className="text-muted-foreground text-sm">Loading classes…</p>
        ) : snapshot.isError ? (
          <ErrorText error={snapshot.error} />
        ) : classes.length === 0 ? (
          <p className="text-sm">No classes yet (School setup → Classes).</p>
        ) : (
          <div className="overflow-x-auto rounded-md border" data-testid="price-grid">
            <table className="w-max min-w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="sticky left-0 bg-inherit p-2 text-left">Class</th>
                  {heads.map((h) => (
                    <th key={h.id} className="p-2 text-left font-medium">
                      {h.name}
                      {h.is_optional && <span className="text-muted-foreground block text-xs">optional</span>}
                    </th>
                  ))}
                  {canManage && <th className="p-2" />}
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <PriceRow
                    key={`${term.id}-${c.id}-${JSON.stringify(savedTexts(setup, term.id, c.id))}`}
                    cls={c}
                    termId={term.id}
                    heads={heads}
                    saved={savedTexts(setup, term.id, c.id)}
                    canManage={canManage}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PriceRow({
  cls,
  termId,
  heads,
  saved,
  canManage,
}: {
  cls: ClassRow;
  termId: string;
  heads: FeeHead[];
  saved: CellTexts;
  canManage: boolean;
}) {
  const save = useSaveFeeStructure();
  const [texts, setTexts] = useState<CellTexts>(saved);
  const [error, setError] = useState<AppError | null>(null);
  const { lines, errors } = useMemo(() => priceLines(heads, texts), [heads, texts]);
  const dirty = !sameTexts(texts, saved, heads);
  const hasErrors = Object.keys(errors).length > 0;

  const onSave = async () => {
    setError(null);
    try {
      const r = await save.mutateAsync({ termId, classId: cls.id, lines });
      toast.success(`${cls.name}: price list saved.${r.note ? ` ${r.note}.` : ''}`);
    } catch (e) {
      setError(toAppError(e));
    }
  };

  return (
    <tr className="border-t align-top" data-testid={`price-row-${cls.name}`}>
      <th scope="row" className="bg-background sticky left-0 p-2 text-left font-medium">
        {cls.name}
        {canManage && (
          <span className="text-muted-foreground block text-xs font-normal" aria-live="polite">
            {save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
          </span>
        )}
      </th>
      {heads.map((h) => {
        const t = texts[h.id] ?? '';
        const blank = t.trim() === '';
        if (!canManage) {
          return (
            <td key={h.id} className="p-2" data-testid={`price-${cls.name}-${h.code}`}>
              {blank ? <span className="text-muted-foreground italic">No price</span> : readOnlyPrice(t)}
            </td>
          );
        }
        return (
          <td key={h.id} className="p-2" data-testid={`price-${cls.name}-${h.code}`}>
            <Input
              value={t}
              inputMode="decimal"
              autoComplete="off"
              placeholder="No price"
              aria-label={`${cls.name} — ${h.name}`}
              aria-invalid={!!errors[h.id] || undefined}
              className={cn(
                'w-28 tabular-nums',
                blank && 'placeholder:text-muted-foreground border-dashed placeholder:italic',
              )}
              onChange={(e) => setTexts((x) => ({ ...x, [h.id]: e.target.value }))}
            />
            <span className="text-muted-foreground mt-0.5 block text-xs">
              {blank ? 'No price' : errors[h.id] ? '' : '₹ price'}
            </span>
            {errors[h.id] && <span className="text-destructive block w-28 text-xs">{errors[h.id]}</span>}
          </td>
        );
      })}
      {canManage && (
        <td className="p-2">
          <Button size="sm" onClick={() => void onSave()} disabled={!dirty || hasErrors || save.isPending}>
            Save {cls.name}
          </Button>
          {error && (
            <div className="mt-1 w-48">
              <ErrorText error={error} />
            </div>
          )}
        </td>
      )}
    </tr>
  );
}
