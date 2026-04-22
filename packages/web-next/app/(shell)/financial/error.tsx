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
      title="Failed to load financial data"
      description="Unable to fetch your financial captures. Please try again."
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
