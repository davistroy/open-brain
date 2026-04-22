'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface SearchErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function SearchError({ error, unstable_retry }: SearchErrorProps) {
  console.error('[Search] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Search unavailable"
      description="Unable to load the search page. Please try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
