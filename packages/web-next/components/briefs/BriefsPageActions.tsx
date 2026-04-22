'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/design-system';
import { NewBriefModal } from './NewBriefModal';

/**
 * Client component that owns the "New brief" button state and the NewBriefModal.
 * Rendered inside the BriefsPage RSC's PageHeader actions slot.
 * Follows the entity-detail-client.tsx pattern of isolating client state from RSC data fetching.
 */
export function BriefsPageActions() {
  const [newBriefOpen, setNewBriefOpen] = useState(false);

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        icon={<Plus size={12} strokeWidth={2} />}
        onClick={() => setNewBriefOpen(true)}
      >
        New brief
      </Button>

      <NewBriefModal open={newBriefOpen} onOpenChange={setNewBriefOpen} />
    </>
  );
}
