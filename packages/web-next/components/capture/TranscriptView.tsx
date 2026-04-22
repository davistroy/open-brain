import { Button, Card } from '@/components/design-system';
import type { Capture, Entity } from '@/lib/types';

interface TranscriptViewProps {
  capture: Capture;
  entities: Entity[];
}

/** One paragraph of transcript with optional timestamp. */
interface TranscriptParagraph {
  timestamp: string | null;
  text: string;
}

/**
 * Parse capture content into paragraphs.
 * Detects timestamped format: "00:00 text" or "[00:00] text".
 * Falls back to splitting on blank lines.
 */
function parseTranscript(content: string): TranscriptParagraph[] {
  const lines = content.split('\n');
  const timestampRe = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.*)/;

  // Check if content looks like a timestamped transcript
  const hasTimestamps = lines.some((l) => timestampRe.test(l.trim()));

  if (hasTimestamps) {
    const paragraphs: TranscriptParagraph[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = timestampRe.exec(trimmed);
      if (match) {
        paragraphs.push({ timestamp: match[1]!, text: match[2]! });
      } else if (paragraphs.length > 0) {
        // Continuation line — append to previous paragraph
        const prev = paragraphs[paragraphs.length - 1]!;
        prev.text += ' ' + trimmed;
      } else {
        paragraphs.push({ timestamp: null, text: trimmed });
      }
    }
    return paragraphs;
  }

  // No timestamps — split on blank lines and treat each block as a paragraph
  const blocks = content.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((text) => ({ timestamp: null, text }));
}

/**
 * Build annotated spans for a paragraph, highlighting entity mentions
 * (book-cloth-50 bg + dotted bottom border) and decision phrases (warm amber bg).
 *
 * Returns an array of { text, type: 'plain' | 'entity' | 'decision' } segments.
 */
interface TextSegment {
  text: string;
  type: 'plain' | 'entity' | 'decision';
}

function annotateText(text: string, entityNames: string[]): TextSegment[] {
  if (entityNames.length === 0) return [{ text, type: 'plain' }];

  // Build a regex that matches entity names (case-insensitive, whole word boundary)
  const escaped = entityNames
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length); // longer first to avoid partial matches

  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);

  return parts
    .filter((p) => p.length > 0)
    .map((part) => {
      const isEntity = escaped.some((n) =>
        new RegExp(`^${n}$`, 'i').test(part),
      );
      return { text: part, type: isEntity ? 'entity' : 'plain' } as TextSegment;
    });
}

/**
 * Transcript paragraph row.
 * timestamp column: 48px min-width, mono 11px, slate-light.
 * Body text: 14px, weight 300, 1.75 line-height.
 * Entity mentions: book-cloth-50 bg + dotted bottom border.
 */
function ParagraphRow({
  paragraph,
  entityNames,
  index,
}: {
  paragraph: TranscriptParagraph;
  entityNames: string[];
  index: number;
}) {
  const segments = annotateText(paragraph.text, entityNames);

  return (
    <div
      className="flex gap-4 py-[10px] border-b border-cloud-light last:border-0"
      style={{ lineHeight: 1.75 }}
    >
      {/* Timestamp column */}
      <div
        className="flex-shrink-0 select-none"
        style={{
          minWidth: 48,
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 11,
          color: 'var(--color-cloud-dark)',
          paddingTop: 2,
          fontVariantNumeric: 'tabular-nums',
        }}
        aria-hidden={!paragraph.timestamp}
      >
        {paragraph.timestamp ?? `¶${index + 1}`}
      </div>

      {/* Body text with entity annotation */}
      <p
        className="flex-1 min-w-0 m-0 text-text-body"
        style={{ fontSize: 14, fontWeight: 300, lineHeight: 1.75 }}
      >
        {segments.map((seg, i) => {
          if (seg.type === 'entity') {
            return (
              <mark
                key={i}
                style={{
                  background: 'var(--color-book-cloth-50)',
                  borderBottom: '1px dotted var(--color-book-cloth)',
                  padding: '0 2px',
                  // Reset mark's default yellow background
                  color: 'inherit',
                }}
              >
                {seg.text}
              </mark>
            );
          }
          return <span key={i}>{seg.text}</span>;
        })}
      </p>
    </div>
  );
}

/**
 * Transcript view — Cloudscape screen 10.
 * Timestamped paragraphs with entity mention highlights.
 * Decision mentions highlighted in warm amber (#FBF6EC).
 * "Edit" ghost button in card header (noop — edit workflow is M5).
 * Server component.
 */
export function TranscriptView({ capture, entities }: TranscriptViewProps) {
  const content = capture.content ?? '';
  const paragraphs = parseTranscript(content);
  const entityNames = entities.map((e) => e.name);

  if (paragraphs.length === 0) {
    return (
      <Card header="Transcript" padded>
        <p
          className="text-text-body-secondary m-0"
          style={{ fontSize: 13.5, fontStyle: 'italic' }}
        >
          No transcript content available.
        </p>
      </Card>
    );
  }

  return (
    <Card
      header="Transcript"
      actions={
        <Button variant="ghost" size="sm" disabled>
          Edit
        </Button>
      }
      padded={false}
    >
      <div className="px-6 py-2">
        {paragraphs.map((para, i) => (
          <ParagraphRow
            key={i}
            paragraph={para}
            entityNames={entityNames}
            index={i}
          />
        ))}
      </div>
    </Card>
  );
}
