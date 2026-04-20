import { useEffect, useState } from 'react';
import { Clock, Globe, MapPin, Smartphone, Watch, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn, formatRelativeTime } from '@/lib/utils';
import { searchApi } from '@/lib/api';
import CaptureCard from '@/components/CaptureCard';
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

/** Known source_metadata keys that get structured rendering */
const KNOWN_KEYS = new Set(['device', 'duration_seconds', 'language', 'location', 'original_filename']);

const DEVICE_LABELS: Record<string, { label: string; icon: typeof Smartphone }> = {
  iphone: { label: 'iPhone', icon: Smartphone },
  apple_watch: { label: 'Apple Watch', icon: Watch },
};

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatMetaKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

interface LocationData {
  latitude?: number;
  longitude?: number;
  name?: string;
  accuracy_meters?: number;
}

function SourceMetadataDisplay({ metadata }: { metadata: Record<string, unknown> }) {
  const device = metadata.device as string | undefined;
  const durationSeconds = metadata.duration_seconds as number | undefined;
  const language = metadata.language as string | undefined;
  const location = metadata.location as LocationData | undefined;

  // Collect unknown keys for fallback rendering
  const unknownEntries = Object.entries(metadata).filter(([key]) => !KNOWN_KEYS.has(key));

  return (
    <div className="space-y-1.5 text-sm">
      {/* Device */}
      {device != null && (() => {
        const deviceKey = String(device).toLowerCase();
        const info = DEVICE_LABELS[deviceKey];
        const DeviceIcon = info?.icon ?? Smartphone;
        const label = info?.label ?? String(device);
        return (
          <div className="flex items-center gap-2">
            <DeviceIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span>{label}</span>
          </div>
        );
      })()}

      {/* Duration */}
      {durationSeconds != null && (
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span>{formatDuration(durationSeconds)}</span>
        </div>
      )}

      {/* Language */}
      {language != null && (
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span>{String(language).toUpperCase()}</span>
        </div>
      )}

      {/* Location */}
      {location != null && (
        <div className="flex items-start gap-2">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            {location.latitude != null && location.longitude != null ? (
              <>
                {location.name ? (
                  <a
                    href={`https://maps.google.com/?q=${location.latitude},${location.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-400 underline underline-offset-2"
                  >
                    {location.name}
                  </a>
                ) : (
                  <a
                    href={`https://maps.google.com/?q=${location.latitude},${location.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-400 underline underline-offset-2 font-mono text-xs"
                  >
                    {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
                  </a>
                )}
                <p className="text-[10px] text-muted-foreground font-mono">
                  {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
                  {location.accuracy_meters != null && ` (±${Math.round(location.accuracy_meters)}m)`}
                </p>
              </>
            ) : (
              location.name && <span>{location.name}</span>
            )}
          </div>
        </div>
      )}

      {/* Unknown keys — formatted key-value fallback */}
      {unknownEntries.length > 0 && (
        <div className="mt-2 space-y-1">
          {unknownEntries.map(([key, value]) => (
            <div key={key} className="flex items-start gap-2 text-xs">
              <span className="text-muted-foreground shrink-0 min-w-[80px]">{formatMetaKey(key)}</span>
              {typeof value === 'object' && value !== null ? (
                <pre className="font-mono text-[10px] bg-secondary rounded px-1.5 py-0.5 overflow-x-auto whitespace-pre-wrap">
                  {formatMetaValue(value)}
                </pre>
              ) : (
                <span className="text-foreground">{formatMetaValue(value)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CaptureDetail({ capture, similarity, onClose }: CaptureDetailProps) {
  const tags = capture.tags ?? [];
  const topics = capture.topics ?? [];
  const entities = capture.entities ?? [];
  const pipelineEvents = capture.pipeline_events ?? [];
  const sourceMetadata = capture.source_metadata ?? {};

  // --- Related captures (spreading activation via search fallback) ---
  const [related, setRelated] = useState<Capture[]>([]);

  useEffect(() => {
    const query = capture.content.slice(0, 200);
    searchApi
      .search({ query, include_related: true, limit: 6 })
      .then((res) => {
        // Exclude the current capture from results; cap at 5
        const filtered = res.captures.filter((c) => c.id !== capture.id).slice(0, 5);
        setRelated(filtered);
      })
      .catch(() => {
        // Non-fatal — section stays hidden
      });
  }, [capture.id, capture.content]);

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
            <p>{capture.updated_at ? formatRelativeTime(capture.updated_at) : '—'}</p>
          </div>
        </div>

        {/* Tags & Topics */}
        {(tags.length > 0 || topics.length > 0) && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Tags &amp; Topics</p>
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
            </div>
          </>
        )}

        {/* Entities */}
        {entities.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Entities</p>
              <div className="space-y-1">
                {entities.map((e) => (
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
        {pipelineEvents.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Pipeline History</p>
              <div className="space-y-2">
                {pipelineEvents.map((ev, i) => (
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
        {Object.keys(sourceMetadata).length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Source Metadata</p>
              <SourceMetadataDisplay metadata={sourceMetadata} />
            </div>
          </>
        )}

        {/* Related captures (spreading activation) */}
        {related.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Related via memory associations</p>
              <div className="space-y-2">
                {related.map((rel) => (
                  <CaptureCard key={rel.id} capture={rel} />
                ))}
              </div>
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
