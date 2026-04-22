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
      title="We lost the thread."
      description="Investment data couldn't load. Your Schwab captures are intact — try again."
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
