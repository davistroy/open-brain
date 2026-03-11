import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntelligenceEntry } from '@/lib/api';

// Mirrors DriftMonitorOutput / DriftItem from workers skill
interface DriftItem {
  item_type: 'bet' | 'commitment' | 'entity';
  item_name: string;
  severity: 'high' | 'medium' | 'low';
  days_silent: number;
  reason: string;
  suggested_action: string;
}

interface DriftMonitorOutput {
  summary: string;
  drift_items: DriftItem[];
  overall_health: 'healthy' | 'minor_drift' | 'significant_drift' | 'critical_drift';
}

interface DriftCardProps {
  entry: IntelligenceEntry;
}

const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-red-100 text-red-800 border-red-200',
  medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  low: 'bg-green-100 text-green-800 border-green-200',
};

const SEVERITY_DOT: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-yellow-500',
  low: 'bg-green-500',
};

const HEALTH_STYLES: Record<string, { label: string; color: string }> = {
  healthy: { label: 'Healthy', color: 'text-green-700 bg-green-100' },
  minor_drift: { label: 'Minor Drift', color: 'text-yellow-700 bg-yellow-100' },
  significant_drift: { label: 'Significant Drift', color: 'text-orange-700 bg-orange-100' },
  critical_drift: { label: 'Critical Drift', color: 'text-red-700 bg-red-100' },
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  bet: 'Bet',
  commitment: 'Commitment',
  entity: 'Entity',
};

function parseResult(entry: IntelligenceEntry): DriftMonitorOutput | null {
  const raw = entry.result;
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as Record<string, unknown>;
  const summary = typeof r.summary === 'string' ? r.summary : '';
  const overall_health = isHealth(r.overall_health) ? r.overall_health : 'healthy';

  const drift_items: DriftItem[] = [];
  if (Array.isArray(r.drift_items)) {
    for (const item of r.drift_items) {
      if (typeof item === 'object' && item !== null) {
        const d = item as Record<string, unknown>;
        drift_items.push({
          item_type: isItemType(d.item_type) ? d.item_type : 'entity',
          item_name: typeof d.item_name === 'string' ? d.item_name : '(unnamed)',
          severity: isSeverity(d.severity) ? d.severity : 'low',
          days_silent: typeof d.days_silent === 'number' ? d.days_silent : 0,
          reason: typeof d.reason === 'string' ? d.reason : '',
          suggested_action: typeof d.suggested_action === 'string' ? d.suggested_action : '',
        });
      }
    }
  }

  return { summary, drift_items, overall_health };
}

function isHealth(val: unknown): val is DriftMonitorOutput['overall_health'] {
  return val === 'healthy' || val === 'minor_drift' || val === 'significant_drift' || val === 'critical_drift';
}

function isSeverity(val: unknown): val is 'high' | 'medium' | 'low' {
  return val === 'high' || val === 'medium' || val === 'low';
}

function isItemType(val: unknown): val is 'bet' | 'commitment' | 'entity' {
  return val === 'bet' || val === 'commitment' || val === 'entity';
}

export default function DriftCard({ entry }: DriftCardProps) {
  const output = parseResult(entry);

  // Fallback: no structured result, show output_summary
  if (!output) {
    return (
      <div className="space-y-2">
        {entry.output_summary && (
          <p className="text-sm text-muted-foreground">{entry.output_summary}</p>
        )}
        {!entry.output_summary && (
          <p className="text-sm text-muted-foreground italic">No structured drift data available.</p>
        )}
      </div>
    );
  }

  const healthInfo = HEALTH_STYLES[output.overall_health] ?? HEALTH_STYLES.healthy;

  return (
    <div className="space-y-3">
      {/* Overall health score */}
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', healthInfo.color)}>
          {healthInfo.label}
        </span>
        {output.drift_items.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {output.drift_items.length} item{output.drift_items.length !== 1 ? 's' : ''} detected
          </span>
        )}
      </div>

      {/* Summary */}
      {output.summary && (
        <p className="text-sm">{output.summary}</p>
      )}

      {/* Drift items */}
      {output.drift_items.length > 0 ? (
        <div className="space-y-2">
          {output.drift_items.map((item, i) => (
            <div
              key={i}
              className="rounded-lg border bg-card p-3 space-y-1.5"
            >
              {/* Header: severity dot + name + badges */}
              <div className="flex items-start gap-2">
                <span className={cn('mt-1.5 inline-block h-2 w-2 rounded-full shrink-0', SEVERITY_DOT[item.severity])} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{item.item_name}</span>
                    <Badge
                      variant="outline"
                      className={cn('text-xs border', SEVERITY_STYLES[item.severity])}
                    >
                      {item.severity}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}
                    </Badge>
                    {item.days_silent > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {item.days_silent}d silent
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Reason */}
              {item.reason && (
                <p className="text-sm text-muted-foreground ml-4">{item.reason}</p>
              )}

              {/* Suggested action */}
              {item.suggested_action && (
                <div className="ml-4 rounded bg-accent/50 px-2 py-1">
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Action:</span> {item.suggested_action}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          No drift items detected — all tracked items are active.
        </p>
      )}
    </div>
  );
}
