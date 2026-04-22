'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface DashboardErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function DashboardError({ error, unstable_retry }: DashboardErrorProps) {
  console.error('[Dashboard] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="Couldn't load the dashboard. Check the API connection and try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
