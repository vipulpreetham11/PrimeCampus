import { Link } from 'react-router';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div>
      <PageHeader title="Page not found" description="This page does not exist or is not available yet." />
      <Button asChild variant="outline">
        <Link to="/dashboard">Go to dashboard</Link>
      </Button>
    </div>
  );
}
