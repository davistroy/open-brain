import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { Capture } from '@/lib/types';

interface CaptureDetailProps {
  capture: Capture;
  similarity?: number;
  onClose: () => void;
}

const PIPELINE_STAGE_DOT: Record<string, string> = {
  complete: 'bg-green-500',
  failed: 'bg-red-500',
  running: 'bg-yellow-500',
  pending: 'bg-gray-300',
  error: 'bg-red-500',
};

export default function CaptureDetail({ capture, similarity, onClose }: CaptureDetailProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-4 border-b">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{capture.capture_type}</Badge>
          <Badge variant="outline">{capture.brain_view}</Badge>
          <Badge variant="secondary">{capture.source}</Badge>
          {similarity !== undefined && (
            <Badge variant="secondary" className="font-mono">
              {(similarity * 100).toFixed(0)}% match
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4 flex-1">
        {/* Main text */}
        <div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{capture.content}</p>
        </div>

        <Separator />

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground">Created</p>
            <p>{formatRelativeTime(capture.created_at)}</p>
            <p className="text-muted-foreground font-mono text-[10px]">
              {new Date(capture.created_at).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Updated</p>
            <p>{formatRelativeTime(capture.updated_at)}</p>
          </div>
        </div>

        {/* Tags & Topics */}
        {(capture.tags.length > 0 || capture.topics.length > 0) && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Tags &amp; Topics</p>
              <div className="flex flex-wrap gap-1">
                {capture.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    #{tag}
                  </Badge>
                ))}
                {capture.topics.map((topic) => (
                  <Badge key={topic} variant="secondary" className="text-xs">
                    {topic}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Entities */}
        {capture.entities.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Entities</p>
              <div className="space-y-1">
                {capture.entities.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-sm">
                    <span className="text-xs text-muted-foreground w-20 shrink-0">{e.type}</span>
                    <span>{e.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Pipeline Events */}
        {capture.pipeline_events.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Pipeline History</p>
              <div className="space-y-2">
                {capture.pipeline_events.map((ev, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        'inline-block w-2 h-2 rounded-full mt-0.5 shrink-0',
                        PIPELINE_STAGE_DOT[ev.status] ?? 'bg-gray-300',
                      )}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{ev.stage}</span>
                        <span className="text-muted-foreground">{ev.status}</span>
                        {ev.duration_ms !== undefined && (
                          <span className="text-muted-foreground font-mono">{ev.duration_ms}ms</span>
                        )}
                      </div>
                      {ev.error && (
                        <p className="text-destructive mt-0.5">{ev.error}</p>
                      )}
                      {ev.started_at && (
                        <p className="text-muted-foreground text-[10px]">
                          {new Date(ev.started_at).toLocaleTimeString()}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Source Metadata */}
        {Object.keys(capture.source_metadata).length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Source Metadata</p>
              <pre className="text-[10px] font-mono bg-secondary rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(capture.source_metadata, null, 2)}
              </pre>
            </div>
          </>
        )}

        {/* ID */}
        <Separator />
        <p className="text-[10px] text-muted-foreground font-mono break-all">{capture.id}</p>
      </div>
    </div>
  );
}
