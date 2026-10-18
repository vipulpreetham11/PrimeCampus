import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { DateField, SelectField, TextAreaField } from '@/components/shared/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import { FOLLOWUP_CHANNELS, FOLLOWUP_OUTCOMES, type LeadDetail } from '@/contracts/admissions';
import { compareIsoDates, formatDate, formatDateTime, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useSetupSnapshot } from '@/features/setup/hooks';
import { STAGE_LABEL } from './EnquiriesPage';
import { LeadFormDialog, SOURCE_LABEL } from './LeadFormDialog';
import { useLead, useRecordFollowup } from './hooks';

const CHANNEL_LABEL: Record<(typeof FOLLOWUP_CHANNELS)[number], string> = {
  phone: 'Phone call',
  walk_in: 'Walk-in',
  visit: 'School visit',
  whatsapp: 'WhatsApp',
  email: 'Email',
  other: 'Other',
};
const OUTCOME_LABEL: Record<(typeof FOLLOWUP_OUTCOMES)[number], string> = {
  reached: 'Spoke to them',
  no_answer: 'No answer',
  callback_requested: 'Asked to call back',
  visit_scheduled: 'Visit scheduled',
  visited: 'Visited the school',
  not_interested: 'Not interested',
  other: 'Other',
};
const KEEP = '__keep__';

function FollowupForm({ leadId }: { leadId: string }) {
  const record = useRecordFollowup();
  const [error, setError] = useState<unknown>(null);
  const today = schoolToday();
  const schema = z
    .object({
      channel: z.enum(FOLLOWUP_CHANNELS),
      outcome: z.enum(FOLLOWUP_OUTCOMES),
      note: z.string().trim().max(1000),
      next_follow_up_on: z
        .string()
        .refine((d) => !d || compareIsoDates(d, today) >= 0, 'Choose today or a later date'),
      stage: z.string(),
      lost_reason: z.string().trim().max(500),
    })
    .refine((v) => v.stage !== 'lost' || v.lost_reason !== '', {
      path: ['lost_reason'],
      message: 'Say why the enquiry was lost',
    });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      channel: 'phone',
      outcome: 'reached',
      note: '',
      next_follow_up_on: '',
      stage: KEEP,
      lost_reason: '',
    },
  });
  const stage = useWatch({ control: form.control, name: 'stage' });

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        aria-label="Log a follow-up"
        onSubmit={form.handleSubmit(async (v) => {
          setError(null);
          try {
            await record.mutateAsync({
              leadId,
              channel: v.channel,
              outcome: v.outcome,
              note: v.note || null,
              nextFollowUpOn: v.next_follow_up_on || null,
              stage: v.stage === KEEP ? null : v.stage,
              lostReason: v.stage === 'lost' ? v.lost_reason : null,
            });
            toast.success('Follow-up logged.');
            form.reset();
          } catch (e) {
            setError(handleSaveError(e));
          }
        })}
      >
        <SelectField
          control={form.control}
          name="channel"
          label="How"
          options={FOLLOWUP_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
        />
        <SelectField
          control={form.control}
          name="outcome"
          label="Outcome"
          options={FOLLOWUP_OUTCOMES.map((c) => ({ value: c, label: OUTCOME_LABEL[c] }))}
        />
        <TextAreaField control={form.control} name="note" label="Note" className="sm:col-span-2" />
        <DateField
          control={form.control}
          name="next_follow_up_on"
          label="Next follow-up"
          min={today}
          description="Leave empty if no further follow-up is planned."
        />
        <SelectField
          control={form.control}
          name="stage"
          label="Stage"
          options={[
            { value: KEEP, label: 'Keep as is (New becomes Contacted)' },
            { value: 'contacted', label: STAGE_LABEL.contacted },
            { value: 'visited', label: STAGE_LABEL.visited },
            { value: 'lost', label: STAGE_LABEL.lost },
          ]}
        />
        {stage === 'lost' && (
          <TextAreaField
            control={form.control}
            name="lost_reason"
            label="Why lost"
            className="sm:col-span-2"
          />
        )}
        <div className="space-y-2 sm:col-span-2">
          <ErrorText error={error} />
          <Button type="submit" disabled={record.isPending}>
            {record.isPending ? 'Saving…' : 'Log follow-up'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

function LeadSummary({ detail, onEdit }: { detail: LeadDetail; onEdit: () => void }) {
  const l = detail.lead;
  const snapshot = useSetupSnapshot(null);
  const className = snapshot.data?.classes.find((c) => c.id === l.interested_class_id)?.name;
  const open = l.stage !== 'converted' && l.stage !== 'lost';
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="text-lg" data-testid="lead-title">
            {l.parent_name}
            {l.child_name ? ` — ${l.child_name}` : ''}
          </CardTitle>
          <p className="text-muted-foreground text-sm">Enquired {formatDateTime(l.created_at)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge data-testid="lead-stage">{STAGE_LABEL[l.stage]}</Badge>
          {l.stage !== 'converted' && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
          )}
          {l.stage === 'converted' && l.converted_student_id ? (
            <Button size="sm" asChild>
              <Link to={`/students/${l.converted_student_id}`}>Open student</Link>
            </Button>
          ) : (
            open && (
              <Button size="sm" asChild>
                <Link to={`/admissions/admit?lead=${l.id}`}>Admit</Link>
              </Button>
            )
          )}
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr_10rem_1fr]">
          <dt className="text-muted-foreground">Mobile</dt>
          <dd>{l.phone}</dd>
          <dt className="text-muted-foreground">Alternate</dt>
          <dd>{l.alt_phone ?? '—'}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{l.email ?? '—'}</dd>
          <dt className="text-muted-foreground">Child’s DOB</dt>
          <dd>{l.child_dob ? formatDate(l.child_dob) : '—'}</dd>
          <dt className="text-muted-foreground">Class wanted</dt>
          <dd>{className ?? (l.interested_class_id ? '…' : 'Not decided')}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>
            {SOURCE_LABEL[l.source]}
            {l.source_detail ? ` — ${l.source_detail}` : ''}
          </dd>
          <dt className="text-muted-foreground">Next follow-up</dt>
          <dd>{l.next_follow_up_on ? formatDate(l.next_follow_up_on) : 'None planned'}</dd>
          {l.lost_reason && (
            <>
              <dt className="text-muted-foreground">Lost because</dt>
              <dd>{l.lost_reason}</dd>
            </>
          )}
        </dl>
        {l.notes && <p className="bg-muted/50 mt-3 rounded p-2 text-sm whitespace-pre-wrap">{l.notes}</p>}
      </CardContent>
    </Card>
  );
}

export function LeadDetailPage() {
  const { leadId } = useParams();
  const query = useLead(leadId);
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-4">
      <Link to="/admissions" className="text-sm underline-offset-2 hover:underline">
        ← All enquiries
      </Link>
      <DataState query={query}>
        {(d) => (
          <>
            <LeadSummary detail={d} onEdit={() => setEditing(true)} />
            {d.same_phone.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Other enquiries with this phone</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1 text-sm">
                    {d.same_phone.map((o) => (
                      <li key={o.lead_id}>
                        <Link to={`/admissions/${o.lead_id}`} className="underline-offset-2 hover:underline">
                          {o.parent_name}
                          {o.child_name ? ` — ${o.child_name}` : ''}
                        </Link>{' '}
                        <Badge variant="outline">{STAGE_LABEL[o.stage]}</Badge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            {d.lead.stage !== 'converted' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Log a follow-up</CardTitle>
                </CardHeader>
                <CardContent>
                  <FollowupForm leadId={d.lead.id} />
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contact history</CardTitle>
              </CardHeader>
              <CardContent>
                {d.followups.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No follow-ups logged yet.</p>
                ) : (
                  <ol className="space-y-2 text-sm" data-testid="followups">
                    {d.followups.map((f) => (
                      <li key={f.id} className="rounded-md border p-2">
                        <p>
                          <span className="font-medium">{OUTCOME_LABEL[f.outcome]}</span> ·{' '}
                          {CHANNEL_LABEL[f.channel]}
                        </p>
                        <p className="text-muted-foreground">
                          {formatDateTime(f.contacted_at)}
                          {f.by ? ` by ${f.by}` : ''}
                          {f.next_follow_up_on ? ` · next: ${formatDate(f.next_follow_up_on)}` : ''}
                        </p>
                        {f.note && <p className="mt-1 whitespace-pre-wrap">{f.note}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
            {editing && (
              <LeadFormDialog
                key={d.lead.version}
                lead={d.lead}
                open
                onOpenChange={setEditing}
                onReload={() => void query.refetch()}
              />
            )}
          </>
        )}
      </DataState>
    </div>
  );
}
