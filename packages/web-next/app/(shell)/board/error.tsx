'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface BoardErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function BoardError({ error, unstable_retry }: BoardErrorProps) {
  console.error('[Board] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="The board couldn't load. Your commitments are still there — try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
