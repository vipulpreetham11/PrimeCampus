import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { PageHeader } from '@/components/shared/PageHeader';
import { UnsavedChangesGuard } from '@/components/shared/roster-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DiaryEntry, HomeworkListItem } from '@/contracts/academic';
import { HomeworkFormDialog } from '@/features/homework/HomeworkFormDialog';
import { HomeworkProgress } from '@/features/homework/HomeworkListPage';
import { useHomeworkList } from '@/features/homework/hooks';
import { formatDate, formatDateLong, formatDateTime, formatTime } from '@/lib/dates';
import { AppError, newRequestId, toAppError } from '@/lib/errors';
import { isConflict } from '@/lib/save-feedback';
import { useCanAny } from '@/lib/scope';
import { useDiaryEntry, useSaveDiary } from './hooks';

// One lesson (brief §3/§6/§7): links to its attendance register, the diary editor and its homework.
// The lesson date and the time the diary was written are shown separately (AC-16).

export const MAX_DIARY_TEXT = 4000;

function lessonIdFrom(raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id <= 0)
    throw new AppError('NOT_FOUND', 'That lesson was not found.', newRequestId());
  return id;
}

export function LessonPage() {
  const params = useParams();
  let lessonId: number | null = null;
  let bad: AppError | null = null;
  try {
    lessonId = lessonIdFrom(params.lessonId);
  } catch (e) {
    bad = toAppError(e);
  }
  const query = useDiaryEntry(lessonId);
  if (bad) return <ErrorText error={bad} />;
  return <DataState query={query}>{(d) => <Lesson data={d} reload={() => query.refetch()} />}</DataState>;
}

function Lesson({ data, reload }: { data: DiaryEntry; reload: () => Promise<unknown> }) {
  const l = data.lesson;
  const staff = useCanAny('lessons.teach', 'attendance.read_all');
  const canSetHomework = useCanAny('lessons.teach', 'academic.correct') && l.status === 'scheduled';
  // kept here: the editor remounts on every new diary version (e.g. after a CONFLICT reload)
  const [mine, setMine] = useState<string | null>(null);
  return (
    <div className="space-y-4" data-testid="lesson-page">
      <PageHeader
        title={`${l.subject} · ${l.section}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {formatDateLong(l.date)} · {l.slot_label} ({formatTime(l.start_time)}–{formatTime(l.end_time)}) ·{' '}
            {l.teacher ?? 'No teacher'}
            {l.status === 'cancelled' && <Badge variant="destructive">Cancelled</Badge>}
          </span>
        }
      />
      {staff && l.status === 'scheduled' && (
        <Button asChild className="min-h-11">
          <Link to={`/attendance/lesson/${l.lesson_session_id}`}>
            <ClipboardCheck aria-hidden="true" /> Attendance register
          </Link>
        </Button>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Diary</CardTitle>
          </CardHeader>
          <CardContent>
            <DiaryEditor
              key={data.entry?.version ?? 'new'}
              data={data}
              reload={reload}
              mine={mine}
              onMine={setMine}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Homework</CardTitle>
          </CardHeader>
          <CardContent>
            <LessonHomework lesson={l} canSet={canSetHomework} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function DiaryEditor({
  data,
  reload,
  mine,
  onMine,
}: {
  data: DiaryEntry;
  reload: () => Promise<unknown>;
  /** After a CONFLICT: the user's own text, shown next to the newer saved text. */
  mine: string | null;
  onMine: (text: string | null) => void;
}) {
  const entry = data.entry;
  const [text, setText] = useState(entry?.body ?? '');
  const [error, setError] = useState<AppError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveDiary();
  const dirty = data.can_edit && text !== (entry?.body ?? '');

  if (!data.can_edit) {
    return entry ? (
      <div className="space-y-2">
        <p className="text-sm whitespace-pre-wrap" data-testid="diary-text">
          {entry.body}
        </p>
        <EntryMeta data={data} />
      </div>
    ) : (
      <p className="text-muted-foreground text-sm">
        {data.lesson.status === 'cancelled'
          ? 'This lesson was cancelled — no diary.'
          : 'No diary written for this lesson yet.'}
      </p>
    );
  }

  const submit = () => {
    setError(null);
    const body = text.trim();
    if (!body) return setProblem('Write something in the diary entry.');
    if (body.length > MAX_DIARY_TEXT) return setProblem(`At most ${MAX_DIARY_TEXT} characters.`);
    setProblem(null);
    save.mutate(
      { lessonId: data.lesson.lesson_session_id, body, expectedVersion: entry?.version ?? null },
      {
        onSuccess: () => toast.success('Diary saved.'),
        onError: (e) => {
          const err = toAppError(e);
          if (isConflict(err)) {
            toast.warning(
              'Someone else updated this diary entry. The newer text is shown — your text is kept below.',
            );
            onMine(body);
            void reload();
            return;
          }
          setError(err);
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      {entry && <EntryMeta data={data} />}
      {!entry && (
        <p className="text-muted-foreground text-sm">
          Lesson on {formatDate(data.lesson.date)}. Write what was covered and anything parents should know.
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="diary-body">What was covered</Label>
        <Textarea
          id="diary-body"
          rows={6}
          value={text}
          maxLength={MAX_DIARY_TEXT}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {text.length} / {MAX_DIARY_TEXT}
        </p>
      </div>
      {mine !== null && (
        <div
          className="rounded-md border border-amber-500 p-3 text-sm"
          role="status"
          data-testid="diary-mine"
        >
          <p className="font-medium">Your text (not saved):</p>
          <p className="mt-1 whitespace-pre-wrap">{mine}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => (setText(mine), onMine(null))}>
              Use my text instead
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onMine(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      <ErrorText error={error} />
      <Button onClick={submit} disabled={!dirty || save.isPending} className="min-h-11">
        {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
        {entry ? 'Save changes' : 'Save diary'}
      </Button>
      <UnsavedChangesGuard when={dirty} />
    </div>
  );
}

function EntryMeta({ data }: { data: DiaryEntry }) {
  const e = data.entry;
  if (!e) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="diary-meta">
      Lesson on {formatDate(data.lesson.date)} · written {formatDateTime(e.created_at)}
      {e.updated_at !== e.created_at && <> · last changed {formatDateTime(e.updated_at)}</>}
      {e.recorded_by_staff && <> · by {e.recorded_by_staff}</>}
    </p>
  );
}

function LessonHomework({ lesson, canSet }: { lesson: DiaryEntry['lesson']; canSet: boolean }) {
  const query = useHomeworkList({
    from: lesson.date,
    to: lesson.date,
    sectionId: lesson.section_id,
    subjectId: null,
    staffId: null,
    status: 'active',
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HomeworkListItem | null>(null);
  const items = (query.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (h) => h.lesson_session_id === lesson.lesson_session_id,
  );
  return (
    <div className="space-y-3">
      <DataState query={query} isEmpty={() => items.length === 0} emptyTitle="No homework set in this lesson">
        {() => (
          <ul className="space-y-2" aria-label="Homework for this lesson">
            {items.map((h) => (
              <li key={h.assignment_id} className="rounded-md border p-3" data-testid="lesson-homework">
                <p className="text-sm whitespace-pre-wrap">{h.description}</p>
                <p className="text-muted-foreground text-xs">Due {formatDate(h.due_on)}</p>
                <HomeworkProgress h={h} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="sm" className="min-h-11 sm:min-h-8">
                    <Link to={`/homework/${h.assignment_id}`} state={{ canCheck: h.can_check }}>
                      {h.can_check ? 'Check homework' : 'See checks'}
                    </Link>
                  </Button>
                  {h.can_edit && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => setEditing(h)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataState>
      {canSet && (
        <Button variant="outline" className="min-h-11" onClick={() => setCreating(true)}>
          Set homework
        </Button>
      )}
      {creating && (
        <HomeworkFormDialog
          lesson={{
            lesson_session_id: lesson.lesson_session_id,
            date: lesson.date,
            section_id: lesson.section_id,
            existingIds: items.map((h) => h.assignment_id),
          }}
          title={`Set homework — ${lesson.subject}, ${lesson.section}`}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <HomeworkFormDialog
          homework={editing}
          title={`Edit homework — ${lesson.subject}`}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
