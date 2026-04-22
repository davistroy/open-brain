'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface InvestmentsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function InvestmentsError({ error, reset }: InvestmentsErrorProps) {
  console.error('[Investments] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Failed to load investment data"
      description="Unable to fetch your Schwab captures. Please try again."
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
