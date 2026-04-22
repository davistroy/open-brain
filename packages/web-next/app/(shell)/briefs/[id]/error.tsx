'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface BriefDetailErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function BriefDetailError({ error, unstable_retry }: BriefDetailErrorProps) {
  console.error('[Brief] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="This brief couldn't load. It may still be generating — try again in a moment."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
