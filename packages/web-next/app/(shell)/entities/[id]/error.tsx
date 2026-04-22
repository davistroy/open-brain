'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface EntityDetailErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function EntityDetailError({ error, unstable_retry }: EntityDetailErrorProps) {
  console.error('[Entity] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="This entity couldn't load. It may have been merged or deleted — try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
