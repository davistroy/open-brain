'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface TimelineErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function TimelineError({ error, unstable_retry }: TimelineErrorProps) {
  console.error('[Timeline] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Failed to load timeline"
      description="Unable to load your captures timeline. Please try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
