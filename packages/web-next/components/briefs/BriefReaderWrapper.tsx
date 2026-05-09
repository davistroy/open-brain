'use client';

import { useEffect } from 'react';
import { BriefReader } from '@/components/briefs/BriefReader';
import { briefsApi } from '@/lib/api-client';
import type { BriefDetail } from '@/lib/types';

interface BriefReaderWrapperProps {
  brief: BriefDetail;
}

/**
 * Client wrapper for BriefReader.
 * Fires mark-as-read on first mount via useEffect (fire-and-forget).
 * BriefReader itself contains no interactivity and is kept as a plain
 * component — this wrapper is the minimal client surface needed.
 *
 * Design notes:
 * - Fire-and-forget: errors are caught and suppressed (non-blocking UX).
 * - Runs once per mount; empty dep array is intentional (id from brief.id).
 * - If the user navigates back and re-opens the brief, mark-as-read fires again
 *   (no-op on the server since read_at is already set — MVP acceptable).
 */
export function BriefReaderWrapper({ brief }: BriefReaderWrapperProps) {
  useEffect(() => {
    briefsApi.patchRead(brief.id, true).catch(() => {
      // Fire-and-forget — mark-as-read failure is non-fatal.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally once per mount (id is stable at mount time)
  }, []);

  return <BriefReader brief={brief} />;
}
