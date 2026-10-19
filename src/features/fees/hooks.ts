import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Json } from '@/generated/database.types';
import type { ChequeStatus, PaymentMethod } from '@/contracts/fees';
import {
  addInvoiceAdjustment,
  bounceCheque,
  cancelCheque,
  cancelInvoice,
  clearCheque,
  evaluateLateFees,
  getCollectionReport,
  getDuesReport,
  getFeeSetup,
  getReceipt,
  getStudentStatement,
  grantConcession,
  issueOpeningBalance,
  issueTermInvoices,
  listCheques,
  listCollections,
  listOptionalFeeRoster,
  listPaymentExceptions,
  listStudentConcessions,
  listStudents,
  postCollection,
  previewTermInvoices,
  recordCheque,
  recordPaymentException,
  resolvePaymentException,
  retireLateFeeRule,
  reverseCollection,
  revokeConcession,
  saveConcessionPreset,
  saveFeeHead,
  saveFeeStructure,
  saveFeeTerm,
  saveLateFeeRule,
  saveReceivingAccount,
  setOptionalFees,
  waiveLateFee,
} from '@/lib/rpc';
import { routeId } from '@/lib/errors';
import { useScopedKey } from '@/lib/scope';

// Fees (M3). Every read is keyed by the context scope (M0); every money mutation invalidates the
// student's statement, the dues, the day book, the cheques and the reports (brief "money rules").

const SETUP_STALE = 60_000;

/** Every query that shows money that a fee mutation can change. */
const MONEY_FEATURES = [
  'fee-statement',
  'fee-dues',
  'fee-day-book',
  'fee-cheques',
  'fee-report',
  'fee-exceptions',
  'fee-concessions',
  'fee-receipt',
  'fee-preview',
];

export function useInvalidateMoney() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () => Promise.all(MONEY_FEATURES.map((f) => qc.invalidateQueries({ queryKey: key(f) })));
}

function useInvalidateSetup() {
  const key = useScopedKey();
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ['fee-setup', 'fee-optional-roster', 'fee-preview'].map((f) =>
        qc.invalidateQueries({ queryKey: key(f) }),
      ),
    );
}

// ------------------------------------------------------------------ setup
export function useFeeSetup(yearId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-setup', yearId),
    queryFn: ({ signal }) => getFeeSetup(yearId ? { p_academic_year_id: yearId } : {}, { signal }),
    staleTime: SETUP_STALE,
  });
}

export interface FeeHeadInput {
  id?: string;
  version?: number;
  name: string;
  code: string;
  kind: 'regular' | 'late_fee' | 'other';
  is_optional: boolean;
  status: 'active' | 'retired';
}
export function feeHeadArgs(v: FeeHeadInput) {
  return {
    p_name: v.name,
    p_code: v.code,
    p_kind: v.kind,
    p_is_optional: v.is_optional,
    p_status: v.status,
    ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
  };
}
export function useSaveFeeHead() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: FeeHeadInput) => saveFeeHead(feeHeadArgs(v)),
    onSettled: () => invalidate(),
  });
}

export function useSaveReceivingAccount() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: { p: Record<string, string>; id?: string; version?: number }) =>
      saveReceivingAccount({ p: v.p, ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}) }),
    onSettled: () => invalidate(),
  });
}

export interface FeeTermInput {
  id?: string;
  version?: number;
  yearId: string;
  name: string;
  sort_order: number;
  due_date: string;
  status?: 'active' | 'retired';
}
export function feeTermArgs(v: FeeTermInput) {
  return {
    p_academic_year_id: v.yearId,
    p_name: v.name,
    p_sort_order: v.sort_order,
    p_due_date: v.due_date,
    ...(v.status ? { p_status: v.status } : {}),
    ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
  };
}
export function useSaveFeeTerm() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: FeeTermInput) => saveFeeTerm(feeTermArgs(v)),
    onSettled: () => invalidate(),
  });
}

/** Only priced heads are sent; a head left out is "No price" for that class and term. */
export function useSaveFeeStructure() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: {
      termId: string;
      classId: string;
      lines: { fee_head_id: string; amount_paise: number }[];
    }) => saveFeeStructure({ p_fee_term_id: v.termId, p_class_id: v.classId, p_lines: v.lines }),
    onSettled: () => invalidate(),
  });
}

export interface PresetInput {
  id?: string;
  version?: number;
  name: string;
  kind: 'fixed' | 'percent';
  percent_bp: number | null;
  fixed_paise: number | null;
  fee_head_ids: string[];
  status: 'active' | 'retired';
}
export function presetArgs(v: PresetInput) {
  return {
    p_name: v.name,
    p_kind: v.kind,
    p_fee_head_ids: v.fee_head_ids,
    ...(v.kind === 'percent'
      ? { p_percent_bp: v.percent_bp ?? undefined }
      : { p_fixed_paise: v.fixed_paise ?? undefined }),
    p_status: v.status,
    ...(v.id ? { p_id: v.id, p_expected_version: v.version } : {}),
  };
}
export function useSavePreset() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: PresetInput) => saveConcessionPreset(presetArgs(v)),
    onSettled: () => invalidate(),
  });
}

export function useSaveLateFeeRule() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (v: { yearId: string; headId: string; amount: number; graceDays: number }) =>
      saveLateFeeRule({
        p_academic_year_id: v.yearId,
        p_fee_head_id: v.headId,
        p_amount_paise: v.amount,
        p_grace_days: v.graceDays,
      }),
    onSettled: () => invalidate(),
  });
}

export function useRetireLateFeeRule() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (yearId: string) => retireLateFeeRule({ p_academic_year_id: yearId }),
    onSettled: () => invalidate(),
  });
}

export function useOptionalRoster(yearId: string | null, headId: string | null, sectionId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-optional-roster', yearId, headId, sectionId),
    queryFn: ({ signal }) =>
      listOptionalFeeRoster(
        { p_academic_year_id: yearId!, p_fee_head_id: headId!, p_section_id: sectionId! },
        { signal },
      ),
    enabled: !!yearId && !!headId && !!sectionId,
    refetchOnWindowFocus: false,
  });
}

export function setOptionalArgs(
  operationId: string,
  yearId: string,
  headId: string,
  changes: { student_id: string; enabled: boolean }[],
) {
  return {
    p_operation_id: operationId,
    p_academic_year_id: yearId,
    p_fee_head_id: headId,
    p_changes: changes,
  };
}
export function useSetOptionalFees() {
  const invalidate = useInvalidateSetup();
  return useMutation({
    mutationFn: (args: ReturnType<typeof setOptionalArgs>) => setOptionalFees(args),
    onSettled: () => invalidate(),
  });
}

// ------------------------------------------------------------------ students
/** Student finder (list_students: students.read_all). Name start or exact admission number. */
export function useStudentSearch(search: string) {
  const key = useScopedKey();
  const q = search.trim();
  return useQuery({
    queryKey: key('fee-student-search', q),
    queryFn: ({ signal }) => listStudents({ p_search: q, p_limit: 20 }, { signal }),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

export function useStatement(studentId: string | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-statement', studentId),
    queryFn: ({ signal }) =>
      getStudentStatement({ p_student_id: routeId(studentId ?? undefined) }, { signal }),
    enabled: studentId !== null,
    staleTime: 0,
  });
}

export function useReceipt(receiptId: string | undefined) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-receipt', receiptId),
    queryFn: ({ signal }) => getReceipt({ p_receipt_id: routeId(receiptId) }, { signal }),
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ concessions
export function useStudentConcessions(f: {
  yearId: string | null;
  studentId: string | null;
  includeRevoked: boolean;
}) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('fee-concessions', f.yearId, f.studentId, f.includeRevoked),
    queryFn: ({ signal, pageParam }) =>
      listStudentConcessions(
        {
          ...(f.yearId ? { p_academic_year_id: f.yearId } : {}),
          ...(f.studentId ? { p_student_id: f.studentId } : {}),
          p_include_revoked: f.includeRevoked,
          p_limit: 100,
          ...(pageParam ? { p_after_id: pageParam } : {}),
        },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export interface GrantInput {
  studentId: string;
  yearId: string;
  presetId: string;
  reason: string;
  termId: string | null;
}
export function grantArgs(operationId: string, v: GrantInput) {
  return {
    p_operation_id: operationId,
    p_student_id: v.studentId,
    p_academic_year_id: v.yearId,
    p_preset_id: v.presetId,
    p_reason: v.reason,
    ...(v.termId ? { p_fee_term_id: v.termId } : {}),
  };
}
export function useGrantConcession() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (args: ReturnType<typeof grantArgs>) => grantConcession(args),
    onSettled: () => void invalidate(),
  });
}
export function useRevokeConcession() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      revokeConcession({ p_student_concession_id: v.id, p_reason: v.reason }),
    onSettled: () => void invalidate(),
  });
}

// ------------------------------------------------------------------ invoicing
export function useTermPreview(termId: string | null, sectionId: string | null, run: number) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-preview', termId, sectionId, run),
    queryFn: ({ signal }) =>
      previewTermInvoices(
        { p_term_id: termId!, ...(sectionId ? { p_section_id: sectionId } : {}) },
        { signal },
      ),
    enabled: termId !== null && run > 0,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function issueArgs(operationId: string, termId: string, sectionId: string | null) {
  return {
    p_operation_id: operationId,
    p_term_id: termId,
    ...(sectionId ? { p_section_id: sectionId } : {}),
  };
}
export function useIssueTermInvoices() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (args: ReturnType<typeof issueArgs>) => issueTermInvoices(args),
    onSettled: () => void invalidate(),
  });
}

export interface OpeningInput {
  studentId: string;
  yearId: string;
  headId: string;
  amount: number;
  origin: string;
  reference: string;
  dueDate: string | null;
}
export function openingArgs(v: OpeningInput) {
  return {
    p_student_id: v.studentId,
    p_academic_year_id: v.yearId,
    p_fee_head_id: v.headId,
    p_amount_paise: v.amount,
    p_origin_label: v.origin,
    p_source_ref: v.reference,
    // left out = the year's start (migration 2320 gave it a default)
    ...(v.dueDate ? { p_due_date: v.dueDate } : {}),
  };
}
export function useIssueOpeningBalance() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: OpeningInput) => issueOpeningBalance(openingArgs(v)),
    onSettled: () => void invalidate(),
  });
}

export type AdjustmentKind = 'discount' | 'additional_charge';
/** A discount is typed as a positive amount and sent negative (the server's sign rule). */
export function adjustmentArgs(
  operationId: string,
  v: { invoiceId: string; kind: AdjustmentKind; amount: number; reason: string },
) {
  return {
    p_operation_id: operationId,
    p_invoice_id: v.invoiceId,
    p_kind: v.kind,
    p_amount_paise: v.kind === 'discount' ? -v.amount : v.amount,
    p_reason: v.reason,
  };
}
export function useAddAdjustment() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (args: ReturnType<typeof adjustmentArgs>) => addInvoiceAdjustment(args),
    onSettled: () => void invalidate(),
  });
}

export function useWaiveLateFee() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { invoiceId: string; reason: string }) =>
      waiveLateFee({ p_invoice_id: v.invoiceId, p_reason: v.reason }),
    onSettled: () => void invalidate(),
  });
}

export function useCancelInvoice() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { operationId: string; invoiceId: string; reason: string }) =>
      cancelInvoice({ p_operation_id: v.operationId, p_invoice_id: v.invoiceId, p_reason: v.reason }),
    onSettled: () => void invalidate(),
  });
}

export function useEvaluateLateFees() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (asOf: string) => evaluateLateFees({ p_as_of: asOf }),
    onSettled: () => void invalidate(),
  });
}

// ------------------------------------------------------------------ collection
export interface AllocationInput {
  invoice_id: string;
  amount_paise: number;
}

export interface CollectionInput {
  studentId: string;
  method: Exclude<PaymentMethod, 'cheque'>;
  amount: number;
  receivedOn: string;
  accountId: string | null;
  reference: string | null;
  payer: string | null;
  notes: string | null;
  allocations: AllocationInput[];
}
/** post_collection arguments without the operation id (the payload the tracker compares). */
export function collectionPayload(v: CollectionInput) {
  return {
    p_student_id: v.studentId,
    p_method: v.method,
    p_amount_paise: v.amount,
    p_received_on: v.receivedOn,
    p_allocations: v.allocations as unknown as Json,
    ...(v.accountId ? { p_receiving_account_id: v.accountId } : {}),
    ...(v.reference ? { p_external_ref: v.reference } : {}),
    ...(v.payer ? { p_payer_name: v.payer } : {}),
    ...(v.notes ? { p_notes: v.notes } : {}),
  };
}
export type CollectionPayload = ReturnType<typeof collectionPayload>;

export interface ChequeInput {
  studentId: string;
  chequeNo: string;
  bankName: string;
  chequeDate: string;
  amount: number;
  accountId: string;
  receivedOn: string;
  allocations: AllocationInput[];
}
export function chequePayload(v: ChequeInput) {
  return {
    p_student_id: v.studentId,
    p_cheque_no: v.chequeNo,
    p_bank_name: v.bankName,
    p_cheque_date: v.chequeDate,
    p_amount_paise: v.amount,
    p_receiving_account_id: v.accountId,
    p_received_on: v.receivedOn,
    p_allocations: v.allocations as unknown as Json,
  };
}
export type ChequePayload = ReturnType<typeof chequePayload>;

export function usePostCollection() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { operationId: string; payload: CollectionPayload }) =>
      postCollection({ p_operation_id: v.operationId, ...v.payload }),
    onSettled: () => void invalidate(),
  });
}

export function useRecordCheque() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { operationId: string; payload: ChequePayload }) =>
      recordCheque({ p_operation_id: v.operationId, ...v.payload }),
    onSettled: () => void invalidate(),
  });
}

export interface ExceptionInput {
  kind: 'overpayment' | 'unidentified' | 'other';
  amount: number;
  note: string;
  studentId: string | null;
  collectionId: string | null;
  reference: string | null;
}
export function exceptionPayload(v: ExceptionInput) {
  return {
    p_kind: v.kind,
    p_amount_paise: v.amount,
    p_note: v.note,
    ...(v.studentId ? { p_student_id: v.studentId } : {}),
    ...(v.collectionId ? { p_collection_id: v.collectionId } : {}),
    ...(v.reference ? { p_reference: v.reference } : {}),
  };
}
export function useRecordException() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { operationId: string; payload: ReturnType<typeof exceptionPayload> }) =>
      recordPaymentException({ p_operation_id: v.operationId, ...v.payload }),
    onSettled: () => void invalidate(),
  });
}

export function reverseArgs(
  operationId: string,
  v: { collectionId: string; reason: string; amount: number | null },
) {
  return {
    p_operation_id: operationId,
    p_collection_id: v.collectionId,
    p_reason: v.reason,
    ...(v.amount !== null ? { p_amount_paise: v.amount } : {}),
  };
}
export function useReverseCollection() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (args: ReturnType<typeof reverseArgs>) => reverseCollection(args),
    onSettled: () => void invalidate(),
  });
}

// ------------------------------------------------------------------ cheques & exceptions
export function useCheques(f: { status: ChequeStatus | null; from: string | null; to: string | null }) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('fee-cheques', f.status, f.from, f.to),
    queryFn: ({ signal, pageParam }) =>
      listCheques(
        {
          // null = every status (the wrapper's default is 'pending')
          p_status: f.status as string,
          ...(f.from ? { p_from: f.from } : {}),
          ...(f.to ? { p_to: f.to } : {}),
          ...(pageParam ? { p_before_date: pageParam.before_date, p_before_id: pageParam.before_id } : {}),
        },
        { signal },
      ),
    initialPageParam: null as { before_date: string; before_id: string } | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useClearCheque() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { chequeId: string; clearedOn: string; allocations: AllocationInput[] | null }) =>
      clearCheque({
        p_cheque_id: v.chequeId,
        p_cleared_on: v.clearedOn,
        ...(v.allocations ? { p_allocations: v.allocations as unknown as Json } : {}),
      }),
    onSettled: () => void invalidate(),
  });
}
export function useBounceCheque() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { chequeId: string; bouncedOn: string; reason: string }) =>
      bounceCheque({ p_cheque_id: v.chequeId, p_bounced_on: v.bouncedOn, p_reason: v.reason }),
    onSettled: () => void invalidate(),
  });
}
export function useCancelCheque() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { chequeId: string; reason: string; version: number }) =>
      cancelCheque({ p_cheque_id: v.chequeId, p_reason: v.reason, p_expected_version: v.version }),
    onSettled: () => void invalidate(),
  });
}

export function useExceptions(status: 'open' | 'resolved' | null) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('fee-exceptions', status),
    queryFn: ({ signal, pageParam }) =>
      listPaymentExceptions(
        { p_status: status as string, ...(pageParam ? { p_before_id: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}
export function useResolveException() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: (v: { id: string; note: string; version: number }) =>
      resolvePaymentException({ p_id: v.id, p_note: v.note, p_expected_version: v.version }),
    onSettled: () => void invalidate(),
  });
}

// ------------------------------------------------------------------ reports
export interface DayBookFilter {
  from: string;
  to: string;
  method: PaymentMethod | null;
  accountId: string | null;
  collectorId: string | null;
  search: string;
}
export function dayBookArgs(f: DayBookFilter) {
  return {
    p_from: f.from,
    p_to: f.to,
    ...(f.method ? { p_method: f.method } : {}),
    ...(f.accountId ? { p_receiving_account_id: f.accountId } : {}),
    ...(f.collectorId ? { p_collected_by: f.collectorId } : {}),
    ...(f.search.trim() ? { p_search: f.search.trim() } : {}),
  };
}
export function useDayBook(f: DayBookFilter) {
  const key = useScopedKey();
  return useInfiniteQuery({
    queryKey: key('fee-day-book', f.from, f.to, f.method, f.accountId, f.collectorId, f.search.trim()),
    queryFn: ({ signal, pageParam }) =>
      listCollections(
        {
          ...dayBookArgs(f),
          p_limit: 100,
          ...(pageParam ? { p_before_date: pageParam.before_date, p_before_id: pageParam.before_id } : {}),
        },
        { signal },
      ),
    initialPageParam: null as { before_date: string; before_id: string } | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useCollectionReport(from: string, to: string) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-report', from, to),
    queryFn: ({ signal }) => getCollectionReport({ p_from: from, p_to: to }, { signal }),
  });
}

export interface DuesFilter {
  yearId: string;
  classId: string | null;
  sectionId: string | null;
  termId: string | null;
  onlyOverdue: boolean;
  onlyWithBalance: boolean;
}
/** The year is always sent (with no year the server mixes every year's balances). */
export function duesArgs(f: DuesFilter) {
  return {
    p_academic_year_id: f.yearId,
    ...(f.classId ? { p_class_id: f.classId } : {}),
    ...(f.sectionId ? { p_section_id: f.sectionId } : {}),
    ...(f.termId ? { p_fee_term_id: f.termId } : {}),
    p_only_overdue: f.onlyOverdue,
    p_only_with_balance: f.onlyWithBalance,
  };
}
export function useDues(f: DuesFilter | null) {
  const key = useScopedKey();
  return useQuery({
    queryKey: key('fee-dues', f),
    queryFn: ({ signal }) => getDuesReport(duesArgs(f!), { signal }),
    enabled: f !== null,
  });
}
