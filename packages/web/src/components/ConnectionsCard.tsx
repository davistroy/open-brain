import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntelligenceEntry } from '@/lib/api';

// Mirrors DailyConnectionsOutput / ConnectionItem from workers skill
interface ConnectionItem {
  theme: string;
  captures: string[];
  insight: string;
  confidence: 'high' | 'medium' | 'low';
  domains: string[];
}

interface DailyConnectionsOutput {
  summary: string;
  connections: ConnectionItem[];
  meta_pattern: string | null;
}

interface ConnectionsCardProps {
  entry: IntelligenceEntry;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'bg-green-100 text-green-800 border-green-200',
  medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
};

function parseResult(entry: IntelligenceEntry): DailyConnectionsOutput | null {
  const raw = entry.result;
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as Record<string, unknown>;
  const summary = typeof r.summary === 'string' ? r.summary : '';
  const meta_pattern = typeof r.meta_pattern === 'string' ? r.meta_pattern : null;

  const connections: ConnectionItem[] = [];
  if (Array.isArray(r.connections)) {
    for (const item of r.connections) {
      if (typeof item === 'object' && item !== null) {
        const c = item as Record<string, unknown>;
        connections.push({
          theme: typeof c.theme === 'string' ? c.theme : '(unnamed)',
          captures: Array.isArray(c.captures) ? c.captures.filter((v): v is string => typeof v === 'string') : [],
          insight: typeof c.insight === 'string' ? c.insight : '',
          confidence: isConfidence(c.confidence) ? c.confidence : 'low',
          domains: Array.isArray(c.domains) ? c.domains.filter((v): v is string => typeof v === 'string') : [],
        });
      }
    }
  }

  return { summary, connections, meta_pattern };
}

function isConfidence(val: unknown): val is 'high' | 'medium' | 'low' {
  return val === 'high' || val === 'medium' || val === 'low';
}

export default function ConnectionsCard({ entry }: ConnectionsCardProps) {
  const output = parseResult(entry);

  // Fallback: no structured result, show output_summary
  if (!output || output.connections.length === 0) {
    return (
      <div className="space-y-2">
        {entry.output_summary && (
          <p className="text-sm text-muted-foreground">{entry.output_summary}</p>
        )}
        {!entry.output_summary && (
          <p className="text-sm text-muted-foreground italic">No structured connections data available.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      {output.summary && (
        <p className="text-sm">{output.summary}</p>
      )}

      {/* Connection items */}
      <div className="space-y-3">
        {output.connections.map((conn, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card p-3 space-y-2"
          >
            {/* Theme + confidence */}
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium leading-snug">{conn.theme}</span>
              <Badge
                variant="outline"
                className={cn('text-xs shrink-0 border', CONFIDENCE_STYLES[conn.confidence])}
              >
                {conn.confidence}
              </Badge>
            </div>

            {/* Insight */}
            {conn.insight && (
              <p className="text-sm text-muted-foreground leading-relaxed">{conn.insight}</p>
            )}

            {/* Domains (cross-domain indicators) */}
            {conn.domains.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {conn.domains.map((domain) => (
                  <Badge key={domain} variant="secondary" className="text-xs">
                    {domain}
                  </Badge>
                ))}
                {conn.domains.length > 1 && (
                  <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 bg-amber-50">
                    cross-domain
                  </Badge>
                )}
              </div>
            )}

            {/* Related captures */}
            {conn.captures.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {conn.captures.length} related capture{conn.captures.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Meta-pattern */}
      {output.meta_pattern && (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-3">
          <p className="text-xs font-medium text-amber-800 mb-1">Meta-pattern</p>
          <p className="text-sm text-amber-900">{output.meta_pattern}</p>
        </div>
      )}
    </div>
  );
}
