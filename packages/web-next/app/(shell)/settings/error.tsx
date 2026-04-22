'use client';

import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { Button } from '@/components/design-system/Button';

interface SettingsErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}

export default function SettingsError({ error, unstable_retry }: SettingsErrorProps) {
  console.error('[Settings] error:', error, error.digest);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="We lost the thread."
      description="Settings couldn't load. Your configuration is unchanged — try again."
      action={
        <Button variant="primary" onClick={unstable_retry}>
          Try again
        </Button>
      }
    />
  );
}
