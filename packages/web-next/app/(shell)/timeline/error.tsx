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
      title="We lost the thread."
      description="Couldn't load the timeline. Try again — captures are still safely stored."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
