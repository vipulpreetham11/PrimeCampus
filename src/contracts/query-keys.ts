// Query keys always start with the context scope (TRD §18, CLAUDE.md rule 12) so a response
// for one role/school/child/revision can never be served in another.
export interface ContextScope {
  accountId: string;
  revision: number;
  schoolId: string;
  role: string;
  studentId: string | null;
}

export type ScopedKey = readonly ['ctx', string, number, string, string, string | null, ...unknown[]];

export function scopedKey(scope: ContextScope, feature: string, ...params: unknown[]): ScopedKey {
  return [
    'ctx',
    scope.accountId,
    scope.revision,
    scope.schoolId,
    scope.role,
    scope.studentId,
    feature,
    ...params,
  ];
}

/** Keys for account-level (no school context) queries, e.g. the Operator's school list. */
export const accountKeys = {
  operatorSchools: (accountId: string) => ['account', accountId, 'operator', 'schools'] as const,
};
