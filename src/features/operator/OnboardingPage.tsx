import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { DataState } from '@/components/shared/DataState';
import { ErrorText } from '@/components/shared/ErrorText';
import { OneTimeSecretDialog } from '@/components/shared/OneTimeSecretDialog';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OperatorSchool } from '@/contracts/session';
import { useOperationId } from '@/lib/operation';
import { useSession } from '@/lib/session/store';
import {
  isDuplicate,
  provisionAdmin,
  reissueTemporaryPassword,
  useCreateSchool,
  useOperatorSchools,
  type IssuedCredential,
} from './hooks';

// Minimal Operator onboarding (M0 brief §6): create organization + school, then provision the
// school's first Admin. The temporary password lives only in component state until the dialog closes.

const NEW_ORG = '__new__';

const schoolSchema = z
  .object({
    orgChoice: z.string().min(1, 'Choose an organization'),
    orgName: z.string().trim().max(200),
    orgCode: z.string().trim(),
    name: z.string().trim().min(1, 'Enter the school name').max(200),
    code: z
      .string()
      .trim()
      .regex(/^[a-z0-9]{2,12}$/, '2–12 lowercase letters or digits, e.g. demo'),
    board: z.string().trim().max(60),
    city: z.string().trim().max(80),
    pincode: z
      .string()
      .trim()
      .regex(/^(\d{6})?$/, 'Pincode must be 6 digits'),
  })
  .superRefine((v, ctx) => {
    if (v.orgChoice !== NEW_ORG) return;
    if (!v.orgName)
      ctx.addIssue({ code: 'custom', path: ['orgName'], message: 'Enter the organization name' });
    if (!/^[a-z0-9-]{2,40}$/.test(v.orgCode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['orgCode'],
        message: '2–40 lowercase letters, digits or dashes',
      });
    }
  });
type SchoolValues = z.infer<typeof schoolSchema>;

const adminSchema = z.object({
  schoolId: z.string().min(1, 'Choose a school'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,62}$/, '3–63 characters: a–z, 0–9, dot, dash or underscore'),
  displayName: z.string().trim().min(1, 'Enter the person’s name').max(200),
});
type AdminValues = z.infer<typeof adminSchema>;

function SchoolsTable({ schools }: { schools: OperatorSchool[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>School</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Organization</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {schools.map((s) => (
            <TableRow key={s.school_id} data-testid={`school-row-${s.code}`}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell className="font-mono">{s.code}</TableCell>
              <TableCell>{s.organization_name}</TableCell>
              <TableCell className="capitalize">{s.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CreateSchoolCard({ schools }: { schools: OperatorSchool[] }) {
  const create = useCreateSchool();
  const orgs = [...new Map(schools.map((s) => [s.organization_id, s])).values()];
  const form = useForm<SchoolValues>({
    resolver: zodResolver(schoolSchema),
    defaultValues: {
      orgChoice: NEW_ORG,
      orgName: '',
      orgCode: '',
      name: '',
      code: '',
      board: '',
      city: '',
      pincode: '',
    },
  });
  const orgChoice = useWatch({ control: form.control, name: 'orgChoice' });

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({
        organization: v.orgChoice === NEW_ORG ? { name: v.orgName, code: v.orgCode } : { id: v.orgChoice },
        school: {
          name: v.name,
          code: v.code,
          ...(v.board ? { board: v.board } : {}),
          ...(v.city ? { city: v.city } : {}),
          ...(v.pincode ? { pincode: v.pincode } : {}),
        },
      });
      toast.success(`School “${v.name}” created.`);
      form.reset();
    } catch {
      /* shown below via create.error */
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">1. Create a school</CardTitle>
        <CardDescription>
          The school code is also the username prefix (for example demo.admin).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
            <FormField
              control={form.control}
              name="orgChoice"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Organization</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NEW_ORG}>New organization…</SelectItem>
                      {orgs.map((o) => (
                        <SelectItem key={o.organization_id} value={o.organization_id}>
                          {o.organization_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {orgChoice === NEW_ORG && (
              <>
                <FormField
                  control={form.control}
                  name="orgName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="orgCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization code</FormLabel>
                      <FormControl>
                        <Input autoCapitalize="none" spellCheck={false} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>School name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>School code</FormLabel>
                  <FormControl>
                    <Input autoCapitalize="none" spellCheck={false} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="board"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Board (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="pincode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Pincode (optional)</FormLabel>
                  <FormControl>
                    <Input inputMode="numeric" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-3 sm:col-span-2">
              <ErrorText error={create.error} />
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create school'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function ProvisionAdminCard({ schools }: { schools: OperatorSchool[] }) {
  const { operationId, reset: resetOperation } = useOperationId();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [dupUsername, setDupUsername] = useState<string | null>(null);
  const form = useForm<AdminValues>({
    resolver: zodResolver(adminSchema),
    defaultValues: { schoolId: '', username: '', displayName: '' },
  });

  const onSubmit = form.handleSubmit(async (v) => {
    setBusy(true);
    setError(null);
    setReplayed(false);
    setDupUsername(null);
    try {
      // Same operationId on every retry of this action (CLAUDE.md rule 4).
      const result = await provisionAdmin({
        operationId,
        username: v.username,
        displayName: v.displayName,
        schoolId: v.schoolId,
      });
      resetOperation();
      if (result) {
        setIssued(result);
        form.reset();
      } else {
        setReplayed(true);
      }
    } catch (e) {
      if (isDuplicate(e)) {
        setDupUsername(v.username);
        resetOperation(); // this request is finished; a new attempt is a new action
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  const reissue = async () => {
    if (!dupUsername) return;
    setBusy(true);
    setError(null);
    try {
      setIssued(await reissueTemporaryPassword(dupUsername));
      setDupUsername(null);
      form.reset();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const schoolId = useWatch({ control: form.control, name: 'schoolId' });
  const prefix = schools.find((s) => s.school_id === schoolId)?.code;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">2. Create the school’s first Admin</CardTitle>
        <CardDescription>
          A temporary password is shown once. The Admin must change it at first sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
            <FormField
              control={form.control}
              name="schoolId"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>School</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(id) => {
                      field.onChange(id);
                      const code = schools.find((s) => s.school_id === id)?.code;
                      if (code && !form.getValues('username')) form.setValue('username', `${code}.admin`);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label="School">
                        <SelectValue placeholder="Choose a school" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {schools.map((s) => (
                        <SelectItem key={s.school_id} value={s.school_id}>
                          {s.name} ({s.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input autoCapitalize="none" spellCheck={false} {...field} />
                  </FormControl>
                  <FormDescription>
                    {prefix ? `Start with “${prefix}.”` : 'Starts with the school code.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-3 sm:col-span-2">
              <ErrorText error={error} />
              {dupUsername && (
                <div className="rounded-md border p-3 text-sm">
                  <p>
                    <strong>{dupUsername}</strong> already exists. You can issue it a new temporary password
                    instead.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => void reissue()}
                  >
                    Issue a new temporary password
                  </Button>
                </div>
              )}
              {replayed && (
                <p role="status" className="text-sm">
                  This Admin was already created by an earlier attempt. Use “Issue a new temporary password”
                  if they need one.
                </p>
              )}
              <Button type="submit" disabled={busy || schools.length === 0}>
                {busy ? 'Working…' : 'Create Admin login'}
              </Button>
            </div>
          </form>
        </Form>
        <OneTimeSecretDialog
          secret={issued?.temporaryPassword ?? null}
          username={issued?.username ?? ''}
          onClose={() => setIssued(null)}
        />
      </CardContent>
    </Card>
  );
}

export function OperatorOnboardingPage() {
  const s = useSession();
  const isOperator = s.account?.isOperator ?? false;
  const schools = useOperatorSchools(isOperator);

  if (!isOperator) {
    return <PageHeader title="Not available" description="This page is for Operators only." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="School onboarding" description="Create a school and its first Admin login." />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schools</CardTitle>
        </CardHeader>
        <CardContent>
          <DataState query={schools} isEmpty={(d) => d.length === 0} emptyTitle="No schools yet">
            {(list) => <SchoolsTable schools={list} />}
          </DataState>
        </CardContent>
      </Card>
      {schools.status === 'success' && (
        <>
          <CreateSchoolCard schools={schools.data} />
          <ProvisionAdminCard schools={schools.data} />
        </>
      )}
    </div>
  );
}
