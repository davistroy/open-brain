'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface BriefsErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function BriefsError({ error, unstable_retry }: BriefsErrorProps) {
  console.error('[Briefs] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Failed to load briefs"
      description="Unable to load the briefs library. Please try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
