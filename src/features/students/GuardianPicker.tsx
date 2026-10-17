import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GuardianSearchItem } from '@/contracts/students';
import { isAppError } from '@/lib/errors';
import { useGuardianSearch } from './hooks';

/**
 * Find an existing parent/guardian before creating a new one (siblings share guardians). Search
 * needs ≥3 characters or a phone number (search_guardians). Phone matches are suggestions only —
 * the same phone never merges two people.
 */
export function GuardianPicker({
  onPick,
  label = 'Find an existing parent or guardian',
  excludeIds = [],
}: {
  onPick: (g: GuardianSearchItem) => void;
  label?: string;
  excludeIds?: string[];
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const search = useGuardianSearch(q);
  const results = (search.data ?? []).filter((g) => !excludeIds.includes(g.guardian_id));
  const tooShort = q.trim().length > 0 && q.trim().length < 3;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name or mobile number"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {tooShort ? 'Type at least 3 characters.' : 'Matching names and numbers appear below.'}
      </p>
      {q.trim().length >= 3 && (
        <div aria-live="polite">
          {search.isFetching && !search.data && <p className="text-muted-foreground text-sm">Searching…</p>}
          {search.isError && (
            <p className="text-destructive text-sm">
              {isAppError(search.error) ? search.error.message : 'Search failed.'}
            </p>
          )}
          {search.isSuccess && results.length === 0 && (
            <p className="text-muted-foreground text-sm">No existing guardian matches “{q.trim()}”.</p>
          )}
          {results.length > 0 && (
            <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
              {results.map((g) => (
                <li key={g.guardian_id}>
                  <button
                    type="button"
                    className="hover:bg-accent focus-visible:bg-accent w-full p-2 text-left text-sm focus-visible:outline-none"
                    onClick={() => onPick(g)}
                    data-testid={`guardian-result-${g.full_name}`}
                  >
                    <span className="font-medium">{g.full_name}</span>
                    {g.phone && <span className="text-muted-foreground"> · {g.phone}</span>}
                    {g.has_login && <span className="text-muted-foreground"> · has login</span>}
                    {g.children.length > 0 && (
                      <span className="text-muted-foreground block text-xs">
                        Parent of {g.children.map((c) => c.name).join(', ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
