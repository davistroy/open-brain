import { Card } from '@/components/design-system';

/**
 * "Needs attention" sidebar card.
 * Placeholder — low-confidence extraction review UI is deferred.
 * Server component.
 */
export function NeedsAttention() {
  return (
    <Card
      header="Needs attention"
      description="Low-confidence extractions"
      padded
    >
      <p className="text-[12px] text-text-body-secondary font-light italic">
        Extraction review coming soon
      </p>
    </Card>
  );
}
