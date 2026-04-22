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
      title="We lost the thread."
      description="Search couldn't load. Try again — the index is still intact."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
