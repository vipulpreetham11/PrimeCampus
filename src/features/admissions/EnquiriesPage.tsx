import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataState } from '@/components/shared/DataState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LEAD_STAGES, type LeadStage } from '@/contracts/admissions';
import { formatDate, schoolDateOf } from '@/lib/dates';
import { LeadFormDialog } from './LeadFormDialog';
import { useFollowupsDue, useLeads } from './hooks';

export const STAGE_LABEL: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  visited: 'Visited',
  converted: 'Admitted',
  lost: 'Lost',
};
const BUCKET_LABEL = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming' } as const;
const ALL = '__all__';

function FollowupsDue() {
  const query = useFollowupsDue(7);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Follow-ups due (next 7 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <DataState query={query} isEmpty={(d) => d.length === 0} emptyTitle="No follow-ups due">
          {(rows) => (
            <ul className="space-y-1 text-sm" data-testid="followups-due">
              {rows.map((f) => (
                <li key={f.lead_id}>
                  <Link
                    to={`/admissions/${f.lead_id}`}
                    className="hover:bg-accent flex flex-wrap items-center justify-between gap-2 rounded px-2 py-1"
                  >
                    <span>
                      <span className="font-medium">{f.parent_name}</span>
                      {f.child_name ? ` for ${f.child_name}` : ''} · {f.phone}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge
                        variant={
                          f.bucket === 'overdue'
                            ? 'destructive'
                            : f.bucket === 'today'
                              ? 'default'
                              : 'outline'
                        }
                      >
                        {BUCKET_LABEL[f.bucket]}
                      </Badge>
                      {formatDate(f.next_follow_up_on)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

export function EnquiriesPage() {
  const [stage, setStage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const query = useLeads(stage, debounced);
  const [creating, setCreating] = useState(false);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Admissions"
        actions={
          <>
            <Button size="sm" variant="outline" asChild>
              <Link to="/admissions/admit">Admit without enquiry</Link>
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              New enquiry
            </Button>
          </>
        }
      />
      <FollowupsDue />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="space-y-1">
          <Label htmlFor="lead-search">Search</Label>
          <Input
            id="lead-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Parent or child name, or phone"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-stage">Stage</Label>
          <Select value={stage ?? ALL} onValueChange={(v) => setStage(v === ALL ? null : v)}>
            <SelectTrigger id="lead-stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All stages</SelectItem>
              {LEAD_STAGES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STAGE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DataState query={query} isEmpty={(d) => d.pages[0]?.items.length === 0} emptyTitle="No enquiries">
        {() => (
          <div className="space-y-3">
            <ul className="bg-background divide-y rounded-md border" aria-label="Enquiries">
              {rows.map((l) => (
                <li key={l.id}>
                  <Link
                    to={`/admissions/${l.id}`}
                    className="hover:bg-accent flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {l.parent_name}
                        {l.child_name ? ` — ${l.child_name}` : ''}
                      </span>
                      <span className="text-muted-foreground block text-sm">
                        {l.phone} · enquired {formatDate(schoolDateOf(new Date(l.created_at)))}
                        {l.next_follow_up_on ? ` · follow up ${formatDate(l.next_follow_up_on)}` : ''}
                      </span>
                    </span>
                    <Badge variant={l.stage === 'lost' ? 'outline' : 'secondary'}>
                      {STAGE_LABEL[l.stage]}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="text-muted-foreground flex items-center justify-between text-sm">
              <span role="status">Showing {rows.length}</span>
              {query.hasNextPage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          </div>
        )}
      </DataState>
      {creating && <LeadFormDialog lead={null} open onOpenChange={setCreating} />}
    </div>
  );
}
