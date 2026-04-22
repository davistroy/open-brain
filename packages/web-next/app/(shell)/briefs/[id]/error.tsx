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
      title="Failed to load brief"
      description="Unable to load this brief. Please try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
