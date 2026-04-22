'use client';

/**
 * VoiceUploadClient — client wrapper for the VoiceUpload page.
 *
 * Owns the brain view selector state and success/error toast display,
 * then passes options down to FileDropZone.
 */

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { FileDropZone } from './FileDropZone';
import type { BrainView } from '@/lib/types';

// ---------------------------------------------------------------------------
// Brain view options
// ---------------------------------------------------------------------------

const BRAIN_VIEWS: { value: BrainView; label: string }[] = [
  { value: 'career',        label: 'Career' },
  { value: 'personal',      label: 'Personal' },
  { value: 'technical',     label: 'Technical' },
  { value: 'work-internal', label: 'Work — Internal' },
  { value: 'client',        label: 'Client' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceUploadClient() {
  const [brainView, setBrainView] = useState<BrainView>('personal');

  const handleSuccess = useCallback((result: { id: string; pipeline_status: string; created_at: string }) => {
    toast.success('Voice memo uploaded — processing in pipeline', {
      description: `Capture ID: ${result.id.slice(0, 8)}…`,
      duration: 5000,
    });
  }, []);

  const handleError = useCallback((message: string) => {
    toast.error('Upload failed', { description: message, duration: 6000 });
  }, []);

  return (
    <div
      className="mx-auto"
      style={{ maxWidth: 600 }}
    >
      {/* Brain view selector */}
      <div className="mb-6">
        <label className="block font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)] mb-2">
          Brain view
        </label>
        <div className="flex flex-wrap gap-2">
          {BRAIN_VIEWS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setBrainView(value)}
              className={[
                'px-3 py-1.5 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] border transition-colors duration-100',
                brainView === value
                  ? 'border-[var(--color-book-cloth)] bg-[var(--color-book-cloth)] text-white'
                  : 'border-[var(--color-rule)] bg-transparent text-[var(--color-text-body-secondary)] hover:text-[var(--color-text-body)] hover:border-[var(--color-text-body-secondary)]',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Drop zone */}
      <FileDropZone
        options={{ brain_view: brainView }}
        onSuccess={handleSuccess}
        onError={handleError}
      />

      {/* Usage notes */}
      <div className="mt-5 space-y-1.5">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
          About voice upload
        </p>
        <ul className="space-y-1 text-[12.5px] text-[var(--color-text-body-secondary)] list-none pl-0">
          <li className="flex gap-2">
            <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
            Transcription happens automatically via Whisper — no manual text needed.
          </li>
          <li className="flex gap-2">
            <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
            The transcript is classified, embedded, and linked to relevant entities.
          </li>
          <li className="flex gap-2">
            <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
            For live recording from iPhone or Apple Watch, use the iOS Shortcut instead.
          </li>
          <li className="flex gap-2">
            <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
            Accepted formats: MP3, M4A, AAC, WAV, OGG, FLAC (max 50 MB).
          </li>
        </ul>
      </div>
    </div>
  );
}
