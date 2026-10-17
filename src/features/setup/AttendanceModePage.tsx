import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { DateField, SelectField } from '@/components/shared/form-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import { compareIsoDates, formatDate, schoolToday } from '@/lib/dates';
import { handleSaveError } from '@/lib/save-feedback';
import { useCan } from '@/lib/scope';
import { useSetAttendanceMode, useSetupSnapshot } from './hooks';

export const MODE_TEXT = {
  daily: {
    label: 'Daily attendance',
    explain: 'Each student is marked once a day (usually by the class teacher in the morning).',
  },
  period: {
    label: 'Period-wise attendance',
    explain:
      'Each student is marked in every lesson by the teacher taking that period. Percentages count lessons, not days.',
  },
} as const;

export function AttendanceModePage() {
  const query = useSetupSnapshot(null);
  const canManage = useCan('setup.manage');
  const save = useSetAttendanceMode();
  const [error, setError] = useState<unknown>(null);
  const today = schoolToday();
  const schema = z.object({
    mode: z.enum(['daily', 'period']),
    effective_from: z
      .string()
      .min(1, 'Choose a start date')
      .refine((d) => !d || compareIsoDates(d, today) >= 0, 'A change cannot start in the past'),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { mode: 'daily', effective_from: today },
  });
  const mode = useWatch({ control: form.control, name: 'mode' });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attendance mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <DataState query={query}>
            {(snap) => {
              const upcoming = snap.attendance_modes.filter(
                (m) => compareIsoDates(m.effective_from, today) > 0,
              );
              return (
                <>
                  <div className="rounded-md border p-3" data-testid="mode-today">
                    <p className="text-muted-foreground">Today</p>
                    <p className="text-base font-medium">{MODE_TEXT[snap.attendance_mode_today].label}</p>
                    <p className="text-muted-foreground">{MODE_TEXT[snap.attendance_mode_today].explain}</p>
                  </div>
                  <div>
                    <p className="mb-1 font-medium">Scheduled changes</p>
                    {upcoming.length === 0 ? (
                      <p className="text-muted-foreground">None scheduled.</p>
                    ) : (
                      <ul className="space-y-1">
                        {upcoming.map((m) => (
                          <li
                            key={m.effective_from}
                            className="bg-muted/50 flex justify-between gap-2 rounded px-2 py-1"
                          >
                            <span>{MODE_TEXT[m.mode].label}</span>
                            <span>from {formatDate(m.effective_from)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              );
            }}
          </DataState>
        </CardContent>
      </Card>
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Schedule a change</CardTitle>
            <CardDescription>
              Changes start today or later. Attendance already marked is never rewritten.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                className="space-y-4"
                noValidate
                onSubmit={form.handleSubmit(async (v) => {
                  setError(null);
                  try {
                    await save.mutateAsync(v);
                    toast.success(`${MODE_TEXT[v.mode].label} from ${formatDate(v.effective_from)}.`);
                  } catch (e) {
                    setError(handleSaveError(e));
                  }
                })}
              >
                <SelectField
                  control={form.control}
                  name="mode"
                  label="Mode"
                  options={[
                    { value: 'daily', label: MODE_TEXT.daily.label },
                    { value: 'period', label: MODE_TEXT.period.label },
                  ]}
                  description={MODE_TEXT[mode].explain}
                />
                <DateField control={form.control} name="effective_from" label="Starts on" min={today} />
                <ErrorText error={error} />
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save change'}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
