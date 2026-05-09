'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { EntityHeader } from './entity-header';
import { AskAIModal } from './ask-ai-modal';
import { MergeEntityModal } from './merge-entity-modal';
import { useGenerateEntityBrief } from '@/lib/api/entities.hooks';
import { SseClient } from '@/lib/sse-client';
import type { EntityDetail } from '@/lib/types';

interface EntityDetailClientProps {
  entity: EntityDetail;
}

/**
 * Client shell for the entity detail page.
 * Owns the modal open/close state so the parent page can be a pure async RSC.
 * Renders EntityHeader (wired buttons) + the two modals.
 * Also owns the "Generate brief" mutation + SSE listener that navigates to the
 * new brief when a brief_created event arrives with matching entity_id.
 * Client component.
 */
export function EntityDetailClient({ entity }: EntityDetailClientProps) {
  const router = useRouter();
  const [askOpen, setAskOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  // Track a pending brief job so the SSE handler can match entity_id.
  const pendingBriefRef = useRef<boolean>(false);

  const briefMutation = useGenerateEntityBrief();

  // Listen for brief_created SSE events. When the entity_id matches, navigate.
  useEffect(() => {
    const client = new SseClient();

    const unsubscribe = client.on((evt) => {
      if (evt.type !== 'brief_created') return;
      if (!pendingBriefRef.current) return;

      const eventEntityId = evt.data.entity_id;
      const briefId = evt.data.brief_id ?? evt.data.id;

      // Only navigate if this event belongs to the entity we triggered a brief for.
      if (eventEntityId !== entity.id) return;

      pendingBriefRef.current = false;
      toast.dismiss('entity-brief');

      if (typeof briefId === 'string') {
        toast.success('Brief ready', {
          action: {
            label: 'Open',
            onClick: () => router.push(`/briefs/${briefId}`),
          },
        });
        router.push(`/briefs/${briefId}`);
      } else {
        // brief_created arrived without an id — invalidate briefs list and toast without link
        toast.success('Brief ready — check your briefs list.');
        router.push('/briefs');
      }
    });

    client.start();

    return () => {
      unsubscribe();
      client.stop();
    };
  }, [entity.id, router]);

  return (
    <>
      <EntityHeader
        entity={entity}
        onAskAI={() => setAskOpen(true)}
        onMerge={() => setMergeOpen(true)}
        onGenerateBrief={() => {
          pendingBriefRef.current = true;
          toast.loading('Generating dossier…', { id: 'entity-brief' });
          briefMutation.mutate(entity.id, {
            onError: () => {
              pendingBriefRef.current = false;
              toast.dismiss('entity-brief');
              toast.error('Brief generation failed — please try again.');
            },
          });
        }}
        isBriefPending={briefMutation.isPending}
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
