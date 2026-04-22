'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function GlobalError({ error, unstable_retry }: GlobalErrorProps) {
  console.error('[Global] error:', error, error.digest);

  return (
    <html>
      <body>
        <div className="flex min-h-screen items-center justify-center">
          <EmptyState
            icon={TriangleAlert}
            title="Something went wrong"
            description="An unexpected error occurred. Please try again."
            action={
              <Button variant="primary" onClick={unstable_retry}>
                Try again
              </Button>
            }
          />
        </div>
      </body>
    </html>
  );
}
