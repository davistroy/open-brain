import { Card, EmptyState } from '@/components/design-system';

/**
 * Active commitments placeholder — commitments extraction is deferred to M3.
 * Matches 06-entity-detail.html:168-184 (structure only; content replaced with stub).
 * Server component.
 */
export function CommitmentsCard() {
  return (
    <Card
      header="Active commitments"
      description="Extracted from captures — waiting, owing, or asked"
      padded={false}
    >
      <EmptyState
        title="Coming in M3"
        description="Commitments extraction is under design"
      />
    </Card>
  );
}
