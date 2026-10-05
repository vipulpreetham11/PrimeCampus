import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
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
import { changePassword, logout } from '@/lib/session/session';
import { useSession } from '@/lib/session/store';
import { AuthCard } from './AuthCard';

// Same bounds as the `accounts` Edge Function (8–72 chars, must differ from current).
const schema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    next: z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
  .refine((v) => v.next !== v.current, { path: ['next'], message: 'Choose a different password' });
type Values = z.infer<typeof schema>;

export function ChangePasswordPage() {
  const s = useSession();
  const navigate = useNavigate();
  const forced = s.status === 'must_change_password';
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { current: '', next: '', confirm: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await changePassword(values.current, values.next);
      form.reset();
      toast.success('Password changed.');
      navigate('/dashboard', { replace: true });
    } catch (e) {
      setError(e);
    }
  });

  return (
    <AuthCard
      title={forced ? 'Set a new password' : 'Change password'}
      description={
        forced
          ? 'You signed in with a temporary password. Choose your own password to continue.'
          : `Signed in as ${s.account?.username ?? ''}.`
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="current"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{forced ? 'Temporary password' : 'Current password'}</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="next"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormDescription>8 to 72 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <ErrorText error={error} />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save new password'}
          </Button>
          <div className="flex justify-between gap-2">
            {!forced && (
              <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={async () => {
                await logout();
                navigate('/sign-in', { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </form>
      </Form>
    </AuthCard>
  );
}
