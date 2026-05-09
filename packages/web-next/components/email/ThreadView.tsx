'use client';

/**
 * ThreadView — groups email captures into threads by normalized subject.
 *
 * Thread reconstruction is client-side:
 *   1. Strip Re:/Fwd:/FW: prefixes (case-insensitive, recursive)
 *   2. Trim + lowercase for grouping key
 *   3. Sort threads by most-recent message
 *   4. Within thread: sort captures by created_at ascending (oldest first)
 *
 * Each thread renders as an expandable accordion row:
 *   - Collapsed: thread subject + message count + most-recent date
 *   - Expanded: ordered list of captures (oldest first)
 *
 * Filter bar integration: senderFilter and dateFrom/dateTo are applied
 * before thread grouping. Sender filter checks if capture content or
 * source_metadata.from contains the filter string.
 */

import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Mail, Inbox } from 'lucide-react';
import { EmptyState } from '@/components/design-system';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Subject normalization
// ---------------------------------------------------------------------------

const RE_FWD_PREFIXES = /^(re|fwd?|fw)\s*:\s*/i;

/** Strip Re:/Fwd:/FW: prefixes recursively, trim and lowercase. */
function normalizeSubject(raw: string): string {
  let s = raw.trim();
  while (true) {
    const stripped = s.replace(RE_FWD_PREFIXES, '').trim();
    if (stripped === s) break;
    s = stripped;
  }
  return s.toLowerCase();
}

/**
 * Extract a display subject from a capture's content or source_metadata.
 * Falls back to the first 80 chars of content.
 */
function extractSubject(capture: Capture): string {
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  if (meta && typeof meta === 'object') {
    const raw = meta['subject'] ?? meta['Subject'];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  // Fall back to first 80 chars of content
  return capture.content.slice(0, 80).trimEnd();
}

/**
 * Extract sender/from from source_metadata or content.
 * Used for sender filter matching.
 */
function extractFrom(capture: Capture): string {
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  if (meta && typeof meta === 'object') {
    const from = meta['from'] ?? meta['From'] ?? meta['sender'];
    if (typeof from === 'string') return from.toLowerCase();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

export interface EmailThread {
  /** Normalized (lowercase, de-prefixed) subject used as grouping key. */
  normalizedSubject: string;
  /** Display subject from the first capture (before normalization). */
  displaySubject: string;
  /** Captures in ascending created_at order (oldest first). */
  captures: Capture[];
  /** ISO string of the most-recent message — used for sorting threads. */
  latestAt: string;
}

function buildThreads(captures: Capture[]): EmailThread[] {
  const map = new Map<string, EmailThread>();

  for (const capture of captures) {
    const rawSubject = extractSubject(capture);
    const key = normalizeSubject(rawSubject);

    if (!map.has(key)) {
      map.set(key, {
        normalizedSubject: key,
        displaySubject: rawSubject,
        captures: [],
        latestAt: capture.created_at,
      });
    }

    const thread = map.get(key)!;
    thread.captures.push(capture);
    if (capture.created_at > thread.latestAt) {
      thread.latestAt = capture.created_at;
    }
  }

  // Sort within each thread: ascending (oldest first)
  for (const thread of map.values()) {
    thread.captures.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }

  // Return threads sorted by most-recent message descending
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Date formatters
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / 3_600_000);
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / 60_000);
      return diffMins <= 1 ? 'Just now' : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// ThreadAccordion
// ---------------------------------------------------------------------------

interface ThreadAccordionProps {
  thread: EmailThread;
}

function ThreadAccordion({ thread }: ThreadAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const { displaySubject, captures, latestAt } = thread;

  return (
    <div className="border border-cloud-light bg-bg-container">
      {/* Thread header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={[
          'w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer',
          'hover:bg-ivory-dark transition-colors duration-fast',
          'border-none bg-transparent',
        ].join(' ')}
        aria-expanded={expanded}
      >
        {/* Chevron */}
        {expanded
          ? <ChevronDown size={13} strokeWidth={1.5} className="text-text-body-secondary shrink-0" />
          : <ChevronRight size={13} strokeWidth={1.5} className="text-text-body-secondary shrink-0" />
        }

        {/* Subject */}
        <span className="flex-1 text-[13.5px] font-normal text-text-heading tracking-[-0.005em] truncate">
          {displaySubject}
        </span>

        {/* Message count badge */}
        <span className="font-mono text-[10.5px] text-text-small tracking-[0.03em] shrink-0">
          {captures.length} msg{captures.length !== 1 ? 's' : ''}
        </span>

        {/* Latest date */}
        <span className="font-mono text-[10px] text-text-small tracking-[0.04em] shrink-0 ml-2">
          {formatRelative(latestAt)}
        </span>
      </button>

      {/* Thread message list — shown when expanded */}
      {expanded && (
        <div className="border-t border-cloud-light divide-y divide-cloud-light">
          {captures.map((capture) => (
            <div key={capture.id} className="px-8 py-3 flex items-start gap-3">
              {/* Icon */}
              <Mail
                size={12}
                strokeWidth={1.5}
                className="text-cloud-dark shrink-0 mt-[2px]"
              />

              {/* Content */}
              <div className="flex-1 min-w-0 space-y-[4px]">
                <p className="text-[13px] font-light text-text-body leading-[1.5] m-0">
                  {capture.content.length > 300
                    ? `${capture.content.slice(0, 300).trimEnd()}…`
                    : capture.content}
                </p>

                {/* Meta */}
                <div className="flex items-center gap-[8px]">
                  <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary">
                    {capture.capture_type}
                  </span>
                  <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
                  <span className="font-mono text-[10px] tracking-[0.05em] text-text-body-secondary">
                    {formatDateTime(capture.created_at)}
                  </span>
                  {capture.pipeline_status !== 'complete' && (
                    <>
                      <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
                      <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary opacity-60">
                        {capture.pipeline_status}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThreadView
// ---------------------------------------------------------------------------

interface ThreadViewProps {
  captures: Capture[];
  senderFilter: string;
  dateFrom: string;
  dateTo: string;
}

export function ThreadView({ captures, senderFilter, dateFrom, dateTo }: ThreadViewProps) {
  const threads = useMemo(() => {
    let filtered = captures;

    // Sender filter
    if (senderFilter.trim()) {
      const lower = senderFilter.trim().toLowerCase();
      filtered = filtered.filter(
        (c) =>
          extractFrom(c).includes(lower) ||
          c.content.toLowerCase().includes(lower),
      );
    }

    // Date range filter
    if (dateFrom) {
      const fromMs = new Date(dateFrom).getTime();
      filtered = filtered.filter((c) => new Date(c.created_at).getTime() >= fromMs);
    }
    if (dateTo) {
      // Include the full "to" day
      const toMs = new Date(dateTo).getTime() + 86_400_000 - 1;
      filtered = filtered.filter((c) => new Date(c.created_at).getTime() <= toMs);
    }

    return buildThreads(filtered);
  }, [captures, senderFilter, dateFrom, dateTo]);

  if (threads.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No threads found"
        description={
          senderFilter || dateFrom || dateTo
            ? 'No email threads match the current filters. Try adjusting the sender or date range.'
            : 'Email captures will appear here grouped by subject once received.'
        }
      />
    );
  }

  const totalMessages = threads.reduce((sum, t) => sum + t.captures.length, 0);

  return (
    <div className="space-y-0">
      {/* Thread count summary */}
      <div className="font-mono text-[10.5px] tracking-[0.05em] uppercase text-text-body-secondary mb-3">
        {threads.length} thread{threads.length !== 1 ? 's' : ''} · {totalMessages} message{totalMessages !== 1 ? 's' : ''}
      </div>

      {/* Thread list */}
      <div className="space-y-[4px]">
        {threads.map((thread) => (
          <ThreadAccordion key={thread.normalizedSubject} thread={thread} />
        ))}
      </div>
    </div>
  );
}
