import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/utils';
import type { AutonomyLevel } from '@/lib/types';

interface SystemStatusStripProps {
  autonomyLevel: AutonomyLevel | null;
  lastConsolidationAt: string | null;
}

const AUTONOMY_BADGE_CLASS: Record<AutonomyLevel, string> = {
  observe: 'bg-gray-100 text-gray-700 border-gray-300',
  assist: 'bg-blue-100 text-blue-700 border-blue-300',
  advise: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  partner: 'bg-red-100 text-red-700 border-red-300',
};

export default function SystemStatusStrip({
  autonomyLevel,
  lastConsolidationAt,
}: SystemStatusStripProps) {
  if (!autonomyLevel && lastConsolidationAt === null) return null;

  const consolidationLabel = lastConsolidationAt
    ? relativeTime(lastConsolidationAt)
    : 'never run';

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      {autonomyLevel && (
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Autonomy</span>
          <Badge
            variant="outline"
            className={`text-xs capitalize ${AUTONOMY_BADGE_CLASS[autonomyLevel]}`}
          >
            {autonomyLevel}
          </Badge>
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground text-xs">Memory consolidation</span>
        <span className="text-xs font-medium">{consolidationLabel}</span>
      </span>
    </div>
  );
}
