'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface EntitiesErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function EntitiesError({ error, unstable_retry }: EntitiesErrorProps) {
  console.error('[Entities] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Failed to load entities"
      description="Unable to load the entities list. Please try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
