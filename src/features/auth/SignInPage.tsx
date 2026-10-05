import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router';
import { ErrorText } from '@/components/shared/ErrorText';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/session/session';
import { sessionStore, useSession } from '@/lib/session/store';
import { homeFor } from '@/app/gate';
import { AuthCard } from './AuthCard';

const schema = z.object({
  username: z.string().trim().min(1, 'Enter your username'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

export function SignInPage() {
  const navigate = useNavigate();
  const { notice } = useSession();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await signIn(values.username, values.password);
      navigate(homeFor(sessionStore.get().status), { replace: true });
    } catch (e) {
      setError(e);
      form.resetField('password');
    }
  });

  return (
    <AuthCard title="Sign in" description="Use the username and password given by your school.">
      {notice?.kind === 'signed_out' && (
        <p
          role="status"
          className="bg-muted mb-4 rounded-md border p-3 text-sm"
          data-testid="signed-out-notice"
        >
          {notice.message}
        </p>
      )}
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Username</FormLabel>
                <FormControl>
                  <Input autoComplete="username" autoCapitalize="none" spellCheck={false} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <ErrorText error={error} />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            Forgot your password? Ask your school office to reset it.
          </p>
        </form>
      </Form>
    </AuthCard>
  );
}
