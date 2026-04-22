import { Card, Pill } from '@/components/design-system';
import type { Capture } from '@/lib/types';

interface CaptureHeaderProps {
  capture: Capture;
  entityCount: number;
}

/** Map CaptureSource to a display label for the mono eyebrow. */
function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    voice: 'VOICE MEMO',
    slack: 'SLACK',
    email: 'EMAIL',
    document: 'DOCUMENT',
    api: 'API',
    mcp: 'MCP',
    file: 'FILE',
    consolidation: 'MEMORY',
    system: 'SYSTEM',
  };
  return map[source] ?? source.toUpperCase();
}

/** Map PipelineStatus to a Pill tone. */
function statusTone(
  status: string,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'complete') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'processing') return 'warning';
  return 'neutral';
}

/** Format ISO 8601 timestamp → "TUE, APR 21" and "07:12" parts. */
function formatCaptureDateParts(iso: string): { datePart: string; timePart: string } {
  try {
    const d = new Date(iso);
    const datePart = d
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      .toUpperCase();
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return { datePart, timePart };
  } catch {
    return { datePart: '', timePart: '' };
  }
}

/** Extract a display title from capture content (first sentence or 80 chars). */
function captureTitle(capture: Capture): string {
  if (capture.title) return capture.title;
  const content = capture.content ?? '';
  const firstSentence = content.split(/[.!?]\s/)[0] ?? content;
  return firstSentence.length > 120 ? firstSentence.slice(0, 117) + '…' : firstSentence;
}

/** Extract duration_seconds from source_metadata if available. */
function getDuration(capture: Capture): string | null {
  // source_metadata is typed as unknown on the base Capture; cast defensively
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  const seconds = meta?.duration_seconds;
  if (typeof seconds !== 'number') return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Capture detail page header — Cloudscape screen 10.
 * Mono eyebrow (SOURCE · DATE · TIME), display-font title (34px/300),
 * metadata line, status/entity pills.
 * Server component.
 */
export function CaptureHeader({ capture, entityCount }: CaptureHeaderProps) {
  const { datePart, timePart } = formatCaptureDateParts(capture.created_at);
  const title = captureTitle(capture);
  const duration = getDuration(capture);

  const eyebrow = [sourceLabel(capture.source), datePart, timePart]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card padded={false}>
      <div className="px-6 pt-5 pb-5">
        {/* Mono eyebrow */}
        <div
          className="mb-[14px]"
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 11,
            letterSpacing: '0.08em',
            color: 'var(--color-cloud-dark)',
          }}
        >
          {eyebrow}
        </div>

        {/* Display-font title */}
        <h1
          className="text-text-heading mb-4"
          style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 34,
            fontWeight: 300,
            lineHeight: 1.15,
            letterSpacing: '-0.015em',
            margin: 0,
            marginBottom: 16,
          }}
        >
          {title}
        </h1>

        {/* Secondary metadata: brain view + capture type */}
        <div
          className="mb-4"
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 11,
            letterSpacing: '0.06em',
            color: 'var(--color-cloud-dark)',
          }}
        >
          {capture.brain_view?.toUpperCase()}
          {capture.capture_type ? ` · ${capture.capture_type.toUpperCase()}` : ''}
        </div>

        {/* Pills row: duration (voice only), status, entity count */}
        <div className="flex flex-wrap items-center gap-2">
          {duration && (
            <Pill tone="neutral" size="sm">
              <span
                style={{
                  fontFamily: 'var(--font-family-monospace)',
                  fontSize: 10.5,
                  letterSpacing: '0.04em',
                }}
              >
                {duration}
              </span>
            </Pill>
          )}

          <Pill tone={statusTone(capture.pipeline_status)} size="sm">
            <span
              style={{
                fontFamily: 'var(--font-family-monospace)',
                fontSize: 10.5,
                letterSpacing: '0.04em',
              }}
            >
              {capture.pipeline_status.toUpperCase()}
            </span>
          </Pill>

          {entityCount > 0 && (
            <Pill tone="accent" size="sm">
              <span
                style={{
                  fontFamily: 'var(--font-family-monospace)',
                  fontSize: 10.5,
                  letterSpacing: '0.04em',
                }}
              >
                {entityCount} {entityCount === 1 ? 'ENTITY' : 'ENTITIES'}
              </span>
            </Pill>
          )}
        </div>
      </div>
    </Card>
  );
}
