import { useSearchParams } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan, useCurrentYearId } from '@/lib/scope';
import { useFeeSetup } from '../hooks';
import { YearSelect } from '../parts';
import { OptionalFeesCard } from './OptionalFeesCard';
import { PriceGrid } from './PriceGrid';
import { AccountsCard, HeadsCard, LateFeeCard, PresetsCard, TermsCard } from './SetupCards';

// Fee setup (brief §1): read with fees.read (get_fee_setup), edit with fees.manage. Heads, receiving
// accounts and concession presets are school-wide; terms, the price list, the late-fee rule and
// optional fees belong to the chosen academic year.

const TABS = [
  { value: 'heads', label: 'Fee heads' },
  { value: 'accounts', label: 'Receiving accounts' },
  { value: 'terms', label: 'Terms' },
  { value: 'prices', label: 'Price list' },
  { value: 'concessions', label: 'Concessions' },
  { value: 'late-fee', label: 'Late fee' },
  { value: 'optional', label: 'Optional fees' },
] as const;

export function FeeSetupPage() {
  const [params, setParams] = useSearchParams();
  const currentYear = useCurrentYearId();
  const yearId = params.get('year') ?? currentYear;
  const tab = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab')! : 'heads';
  const setup = useFeeSetup(yearId);
  const canManage = useCan('fees.manage');
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title="Fee setup"
        description={
          canManage ? undefined : 'You can view fee setup. Only staff who manage fees can change it.'
        }
        actions={<YearSelect value={yearId} onChange={(y) => set('year', y)} />}
      />
      <Tabs value={tab} onValueChange={(v) => set('tab', v)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <DataState query={setup}>
          {(s) => (
            <>
              <TabsContent value="heads">
                <HeadsCard setup={s} canManage={canManage} onReload={() => void setup.refetch()} />
              </TabsContent>
              <TabsContent value="accounts">
                <AccountsCard setup={s} canManage={canManage} onReload={() => void setup.refetch()} />
              </TabsContent>
              <TabsContent value="terms">
                <TermsCard
                  setup={s}
                  yearId={yearId}
                  canManage={canManage}
                  onReload={() => void setup.refetch()}
                />
              </TabsContent>
              <TabsContent value="prices">
                <PriceGrid setup={s} yearId={yearId} canManage={canManage} />
              </TabsContent>
              <TabsContent value="concessions">
                <PresetsCard setup={s} canManage={canManage} onReload={() => void setup.refetch()} />
              </TabsContent>
              <TabsContent value="late-fee">
                <LateFeeCard setup={s} yearId={yearId} canManage={canManage} />
              </TabsContent>
              <TabsContent value="optional">
                <OptionalFeesCard setup={s} yearId={yearId} canManage={canManage} />
              </TabsContent>
            </>
          )}
        </DataState>
      </Tabs>
    </div>
  );
}
