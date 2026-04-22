'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface CaptureDetailErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function CaptureDetailError({ error, unstable_retry }: CaptureDetailErrorProps) {
  console.error('[CaptureDetail] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread"
      description="Unable to load this capture. It may have been deleted or is temporarily unavailable."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
