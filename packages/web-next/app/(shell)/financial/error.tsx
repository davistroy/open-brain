'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface FinancialErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function FinancialError({ error, reset }: FinancialErrorProps) {
  console.error('[Financial] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="Financial data couldn't load. Your captures are intact — try again."
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
