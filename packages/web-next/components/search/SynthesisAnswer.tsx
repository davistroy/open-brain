'use client';

/**
 * SynthesisAnswer — conditional AI synthesis card above search results.
 *
 * Only renders when isSynthesisRequest(query) returns true (question-like
 * queries such as "What have I decided about X?" or queries ending in "?").
 *
 * Fetches via POST /api/v1/synthesize. Uses TanStack Query so the
 * synthesis result is cached and not re-fetched on re-render.
 *
 * Response shape: { response: string, capture_count: number }
 * (fixed from incorrect { answer, sources, query } type — see api-client.ts)
 */

import { Brain, Loader2 } from 'lucide-react';
import { useSynthesizeQuery } from '@/lib/api/synthesize.hooks';
import { isSynthesisRequest } from '@/lib/synthesis-detect';
import { Eyebrow } from '@/components/design-system/Eyebrow';

interface SynthesisAnswerProps {
  query: string;
}

export function SynthesisAnswer({ query }: SynthesisAnswerProps) {
  // Only show this component for synthesis-style queries
  const shouldSynthesize = isSynthesisRequest(query);

  const { data, isLoading, isError, error } = useSynthesizeQuery(
    { query },
    { enabled: shouldSynthesize },
  );

  // Don't render anything for non-synthesis queries
  if (!shouldSynthesize) return null;

  return (
    <div className="rounded-container border border-cloud-medium bg-bg-container overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-[10px] border-b border-cloud-light bg-ivory-dark">
        <Brain size={13} strokeWidth={1.5} className="text-book-cloth shrink-0" />
        <Eyebrow>AI Synthesis</Eyebrow>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-[13px] text-text-body-secondary font-light py-1">
            <Loader2 size={13} className="animate-spin shrink-0" strokeWidth={1.5} />
            Synthesizing from your captures…
          </div>
        )}

        {isError && (
          <p className="text-[13px] text-status-error-fg font-light">
            Synthesis unavailable: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        )}

        {data && (
          <>
            <div className="text-[13.5px] font-light text-text-body leading-[1.6] whitespace-pre-wrap">
              {data.response}
            </div>
            {data.capture_count > 0 && (
              <p className="text-[11.5px] font-mono tracking-[0.04em] uppercase text-text-body-secondary mt-3">
                Synthesized from {data.capture_count} capture{data.capture_count !== 1 ? 's' : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
