'use client';

import { useState } from 'react';
import { EntityHeader } from './entity-header';
import { AskAIModal } from './ask-ai-modal';
import { MergeEntityModal } from './merge-entity-modal';
import type { EntityDetail } from '@/lib/types';

interface EntityDetailClientProps {
  entity: EntityDetail;
}

/**
 * Client shell for the entity detail page.
 * Owns the modal open/close state so the parent page can be a pure async RSC.
 * Renders EntityHeader (wired buttons) + the two modals.
 * Client component.
 */
export function EntityDetailClient({ entity }: EntityDetailClientProps) {
  const [askOpen, setAskOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <>
      <EntityHeader
        entity={entity}
        onAskAI={() => setAskOpen(true)}
        onMerge={() => setMergeOpen(true)}
      />

      <AskAIModal
        entityId={entity.id}
        entityName={entity.name}
        open={askOpen}
        onOpenChange={setAskOpen}
      />

      <MergeEntityModal
        entityId={entity.id}
        entityName={entity.name}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
    </>
  );
}
