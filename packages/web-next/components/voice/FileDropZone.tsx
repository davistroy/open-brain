'use client';

/**
 * FileDropZone — drag-and-drop + click-to-select audio file upload.
 *
 * Submits a multipart FormData POST to the voice-capture service.
 * Field name is `file` (not `audio`) per CLAUDE.md.
 * Optional fields: brain_view, latitude, longitude, location_name, location_accuracy.
 */

import { useState, useRef, useCallback } from 'react';
import { Mic, Upload, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/design-system';
import type { BrainView } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceUploadOptions {
  brain_view?: BrainView;
  latitude?: number;
  longitude?: number;
  location_name?: string;
  location_accuracy?: number;
}

interface UploadResult {
  id: string;
  pipeline_status: string;
  created_at: string;
}

type UploadState =
  | { status: 'idle' }
  | { status: 'dragging' }
  | { status: 'selected'; file: File }
  | { status: 'uploading'; file: File; progress: number }
  | { status: 'success'; result: UploadResult; file: File }
  | { status: 'error'; message: string; file?: File };

interface FileDropZoneProps {
  options?: VoiceUploadOptions;
  onSuccess?: (result: UploadResult) => void;
  onError?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Accepted audio MIME types
// ---------------------------------------------------------------------------

const ACCEPTED_MIME = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'video/mp4',    // Some recorders produce .mp4 container
];

const ACCEPTED_EXTENSIONS = '.mp3,.mp4,.m4a,.aac,.wav,.ogg,.webm,.flac';
const MAX_FILE_MB = 50;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `File too large (${formatFileSize(file.size)}). Maximum is ${MAX_FILE_MB} MB.`;
  }
  // Accept by MIME type or extension fallback
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const validExt = ['mp3', 'mp4', 'm4a', 'aac', 'wav', 'ogg', 'webm', 'flac'];
  if (!ACCEPTED_MIME.includes(file.type) && !validExt.includes(ext)) {
    return `Unsupported format "${file.type || ext}". Accepted: MP3, M4A, AAC, WAV, OGG, FLAC.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload function — hits the voice-capture service via /voice-api proxy
// ---------------------------------------------------------------------------

async function uploadVoiceFile(file: File, options: VoiceUploadOptions = {}): Promise<UploadResult> {
  const formData = new FormData();
  // Field name MUST be `file` per CLAUDE.md voice-capture multipart spec
  formData.append('file', file, file.name);

  if (options.brain_view) formData.append('brain_view', options.brain_view);
  if (options.latitude !== undefined) formData.append('latitude', String(options.latitude));
  if (options.longitude !== undefined) formData.append('longitude', String(options.longitude));
  if (options.location_name) formData.append('location_name', options.location_name);
  if (options.location_accuracy !== undefined) formData.append('location_accuracy', String(options.location_accuracy));

  const response = await fetch('/voice-api/upload', {
    method: 'POST',
    headers: {
      // Do NOT set Content-Type — browser sets it automatically with boundary for multipart
      'X-Open-Brain-Caller': 'web-ui',
    },
    body: formData,
  });

  if (!response.ok) {
    let msg = `Upload failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  return response.json() as Promise<UploadResult>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileDropZone({ options = {}, onSuccess, onError }: FileDropZoneProps) {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);  // Track nested drag-enter/leave events

  // ---------------------------------------------------------------------------
  // File selection
  // ---------------------------------------------------------------------------

  const selectFile = useCallback((file: File) => {
    const error = validateFile(file);
    if (error) {
      setState({ status: 'error', message: error });
      onError?.(error);
      return;
    }
    setState({ status: 'selected', file });
  }, [onError]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) selectFile(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, [selectFile]);

  // ---------------------------------------------------------------------------
  // Drag events
  // ---------------------------------------------------------------------------

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.items.length > 0) {
      setState((s) => s.status === 'uploading' || s.status === 'success' ? s : { status: 'dragging' });
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setState((s) => s.status === 'dragging' ? { status: 'idle' } : s);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    const file = e.dataTransfer.files[0];
    if (file) selectFile(file);
    else setState({ status: 'idle' });
  }, [selectFile]);

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  const handleUpload = useCallback(async () => {
    if (state.status !== 'selected') return;
    const { file } = state;

    setState({ status: 'uploading', file, progress: 0 });

    // Simulate progress while actual upload is in-flight (no XHR progress events via fetch)
    let tick = 0;
    const interval = setInterval(() => {
      tick += Math.random() * 8;
      const progress = Math.min(90, tick);
      setState((s) => s.status === 'uploading' ? { ...s, progress } : s);
    }, 300);

    try {
      const result = await uploadVoiceFile(file, options);
      clearInterval(interval);
      setState({ status: 'success', result, file });
      onSuccess?.(result);
    } catch (err) {
      clearInterval(interval);
      const message = err instanceof Error ? err.message : 'Upload failed';
      setState({ status: 'error', message, file });
      onError?.(message);
    }
  }, [state, options, onSuccess, onError]);

  const handleReset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const isDragging = state.status === 'dragging';
  const isUploading = state.status === 'uploading';

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (state.status === 'success') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-[4px] border border-[var(--color-rule)] bg-[#f9f7f4] px-6 py-12 text-center"
        style={{ minHeight: 220 }}
      >
        <CheckCircle size={36} strokeWidth={1.2} className="text-[#5c7a5c]" />
        <div>
          <p className="font-display text-[16px] text-[var(--color-text-body)] mb-1">Upload successful</p>
          <p className="font-mono text-[11px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
            {state.file.name} · Processing in pipeline
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={handleReset}>
          Upload another
        </Button>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-[4px] border border-[var(--color-rule)] bg-[#faf7f4] px-6 py-12 text-center"
        style={{ minHeight: 220 }}
      >
        <AlertCircle size={36} strokeWidth={1.2} className="text-[#b05040]" />
        <div>
          <p className="font-display text-[16px] text-[var(--color-text-body)] mb-1">Upload failed</p>
          <p className="text-[12.5px] text-[var(--color-text-body-secondary)] max-w-[320px]">
            {state.message}
          </p>
        </div>
        <div className="flex gap-2">
          {state.file && (
            <Button variant="primary" size="sm" onClick={() => setState({ status: 'selected', file: state.file! })}>
              Retry
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={handleReset}>
            Start over
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => state.status === 'idle' && inputRef.current?.click()}
      className={[
        'flex flex-col items-center justify-center gap-5 rounded-[4px] border-2 border-dashed px-6 py-12 text-center transition-colors duration-150',
        isDragging
          ? 'border-[var(--color-book-cloth)] bg-[#f0ebe4] cursor-copy'
          : state.status === 'selected' || state.status === 'uploading'
            ? 'border-[var(--color-rule)] bg-[#f9f7f4] cursor-default'
            : 'border-[var(--color-rule)] bg-[#faf8f5] hover:bg-[#f5f2ec] cursor-pointer',
      ].join(' ')}
      style={{ minHeight: 220 }}
      role={state.status === 'idle' ? 'button' : undefined}
      tabIndex={state.status === 'idle' ? 0 : undefined}
      aria-label={state.status === 'idle' ? 'Select audio file to upload' : undefined}
      onKeyDown={(e) => {
        if (state.status === 'idle' && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        className="sr-only"
        onChange={handleFileInput}
        aria-hidden="true"
      />

      {/* Icon */}
      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[var(--color-book-cloth)] bg-opacity-10">
        {isUploading ? (
          <Loader2 size={22} strokeWidth={1.4} className="text-[var(--color-book-cloth)] animate-spin" />
        ) : state.status === 'selected' ? (
          <Mic size={22} strokeWidth={1.4} className="text-[var(--color-book-cloth)]" />
        ) : (
          <Upload size={22} strokeWidth={1.4} className="text-[var(--color-book-cloth)]" />
        )}
      </div>

      {/* Copy */}
      {state.status === 'idle' && (
        <div>
          <p className="font-display text-[15px] text-[var(--color-text-body)] mb-1">
            {isDragging ? 'Drop to upload' : 'Drop an audio file, or click to browse'}
          </p>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            MP3 · M4A · WAV · AAC · OGG · FLAC · Max {MAX_FILE_MB} MB
          </p>
        </div>
      )}

      {(state.status === 'selected' || state.status === 'uploading') && (
        <div className="w-full max-w-[340px]">
          {/* File info row */}
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <Mic size={14} strokeWidth={1.4} className="text-[var(--color-book-cloth)] shrink-0" />
              <span className="font-mono text-[11px] text-[var(--color-text-body)] truncate">
                {state.file.name}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)]">
                {formatFileSize(state.file.size)}
              </span>
              {!isUploading && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleReset(); }}
                  className="text-[var(--color-text-body-secondary)] hover:text-[var(--color-text-body)] transition-colors"
                  aria-label="Remove file"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>

          {/* Progress bar (uploading) */}
          {isUploading && (
            <div className="mb-4">
              <div className="h-[2px] w-full rounded-full bg-[var(--color-rule)] overflow-hidden">
                <div
                  className="h-full bg-[var(--color-book-cloth)] transition-all duration-300 rounded-full"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
              <p className="mt-1.5 font-mono text-[10px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
                Uploading…
              </p>
            </div>
          )}

          {/* Action buttons (selected, not uploading) */}
          {!isUploading && (
            <div className="flex gap-2 justify-center">
              <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); void handleUpload(); }}>
                Upload
              </Button>
              <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); handleReset(); }}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
