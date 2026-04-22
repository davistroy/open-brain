'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface ShellErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function ShellError({ error, unstable_retry }: ShellErrorProps) {
  console.error('[Shell] error:', error, error.digest);

  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={TriangleAlert}
        title="We lost the thread."
        description="Something went wrong loading this page. Try again — it usually sorts itself out."
        action={
          <Button variant="primary" onClick={unstable_retry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
