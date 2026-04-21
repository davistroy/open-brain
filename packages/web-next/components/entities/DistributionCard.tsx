import { Card } from '@/components/design-system';
import type { EntityDistribution } from '@/lib/types';

interface DistributionCardProps {
  distribution: EntityDistribution[];
}

/**
 * Entity type distribution bar chart.
 * Renders one row per type: label + mono count + 3px bar.
 * Bar width is relative to the max count in the list.
 * Server component.
 */
export function DistributionCard({ distribution }: DistributionCardProps) {
  const maxCount = Math.max(...distribution.map((d) => d.count));

  return (
    <Card header="Distribution" padded>
      <div className="flex flex-col gap-[10px]">
        {distribution.map((d) => (
          <div key={d.label}>
            <div className="flex justify-between text-[12px] text-text-body mb-[4px]">
              <span className="font-light">{d.label}</span>
              <span className="font-mono">{d.count}</span>
            </div>
            <div className="h-[3px] bg-cloud-light relative">
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${(d.count / maxCount) * 100}%`,
                  background: d.tone,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
