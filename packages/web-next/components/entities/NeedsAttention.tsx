import { Card } from '@/components/design-system';

/**
 * "Needs attention" sidebar card.
 * M3 placeholder — low-confidence extraction review UI is deferred.
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
        Coming in M3
      </p>
    </Card>
  );
}
