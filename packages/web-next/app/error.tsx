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
            title="We lost the thread."
            description="Something went wrong. Try again — it usually sorts itself out."
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
