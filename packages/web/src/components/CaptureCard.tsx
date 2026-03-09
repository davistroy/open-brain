import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn, formatRelativeTime, truncate } from '@/lib/utils';
import type { Capture } from '@/lib/types';

const CAPTURE_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-blue-100 text-blue-800 border-blue-200',
  idea: 'bg-purple-100 text-purple-800 border-purple-200',
  observation: 'bg-gray-100 text-gray-800 border-gray-200',
  task: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  win: 'bg-green-100 text-green-800 border-green-200',
  blocker: 'bg-red-100 text-red-800 border-red-200',
  question: 'bg-orange-100 text-orange-800 border-orange-200',
  reflection: 'bg-indigo-100 text-indigo-800 border-indigo-200',
};

const SOURCE_LABELS: Record<string, string> = {
  slack: 'Slack',
  voice: 'Voice',
  api: 'API',
  mcp: 'MCP',
  system: 'System',
  bookmark: 'Bookmark',
  calendar: 'Calendar',
};

const PIPELINE_STATUS_COLORS: Record<string, string> = {
  complete: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  processing: 'bg-yellow-100 text-yellow-700',
  pending: 'bg-gray-100 text-gray-700',
  partial: 'bg-orange-100 text-orange-700',
};

interface CaptureCardProps {
  capture: Capture;
  similarity?: number;
  defaultExpanded?: boolean;
  className?: string;
}

export default function CaptureCard({ capture, similarity, defaultExpanded = false, className }: CaptureCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const typeColor = CAPTURE_TYPE_COLORS[capture.capture_type] ?? 'bg-gray-100 text-gray-800 border-gray-200';
  const statusColor = PIPELINE_STATUS_COLORS[capture.pipeline_status] ?? 'bg-gray-100 text-gray-700';

  const tags = capture.tags ?? [];
  const topics = capture.topics ?? [];
  const entities = capture.entities ?? [];
  const pipelineEvents = capture.pipeline_events ?? [];

  return (
    <Card
      className={cn('cursor-pointer hover:border-primary/50 transition-colors', className)}
      onClick={() => setExpanded((v) => !v)}
    >
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start gap-2 mb-2">
          <span className="mt-0.5 text-muted-foreground shrink-0">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>

          <div className="flex-1 min-w-0">
            <p className={cn('text-sm leading-snug', expanded ? '' : 'line-clamp-2')}>
              {expanded ? capture.content : truncate(capture.content, 200)}
            </p>
          </div>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-1.5 ml-6">
          <Badge variant="outline" className={cn('text-xs border', typeColor)}>
            {capture.capture_type}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {capture.brain_view}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {SOURCE_LABELS[capture.source] ?? capture.source}
          </Badge>
          <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', statusColor)}>
            {capture.pipeline_status}
          </span>
          {similarity !== undefined && (
            <span className="text-xs text-muted-foreground font-mono">
              {(similarity * 100).toFixed(0)}% match
            </span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {formatRelativeTime(capture.created_at)}
          </span>
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-3 ml-6 space-y-3 border-t pt-3">
            {/* Tags & Topics */}
            {(tags.length > 0 || topics.length > 0) && (
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    #{tag}
                  </Badge>
                ))}
                {topics.map((topic) => (
                  <Badge key={topic} variant="secondary" className="text-xs">
                    {topic}
                  </Badge>
                ))}
              </div>
            )}

            {/* Entities */}
            {entities.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Entities</p>
                <div className="flex flex-wrap gap-1">
                  {entities.map((e) => (
                    <span
                      key={e.id}
                      className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs"
                    >
                      <span className="text-muted-foreground">{e.type}:</span>
                      {e.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Pipeline events */}
            {pipelineEvents.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Pipeline</p>
                <div className="space-y-0.5">
                  {pipelineEvents.map((ev, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span
                        className={cn(
                          'inline-block w-1.5 h-1.5 rounded-full shrink-0',
                          ev.status === 'complete'
                            ? 'bg-green-500'
                            : ev.status === 'error'
                            ? 'bg-red-500'
                            : ev.status === 'running'
                            ? 'bg-yellow-500'
                            : 'bg-gray-300',
                        )}
                      />
                      <span className="w-16 text-muted-foreground">{ev.stage}</span>
                      <span className="text-muted-foreground">{ev.status}</span>
                      {ev.duration_ms !== undefined && (
                        <span className="text-muted-foreground font-mono">{ev.duration_ms}ms</span>
                      )}
                      {ev.error && <span className="text-destructive truncate">{ev.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ID */}
            <p className="text-[10px] text-muted-foreground font-mono">{capture.id}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
