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
      title="We lost the thread."
      description="The entities list couldn't load. Try again — entity data is still intact."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
