'use client';

/**
 * FileDropZone — drag-and-drop + click-to-select file upload for the Ingest page.
 *
 * Accepts financial / utility data files. Submits via FormData to
 * `ingestApi.upload(file, opts)` → returns upload_id. After upload,
 * calls `onUploaded(uploadId)` so the parent can subscribe to SSE progress.
 *
 * Accepted types (mirrors core-api ingest route heuristics):
 *   CSV — financial statements, utility exports
 *   PDF — utility bills, scanned statements
 *   TXT — raw exports
 */

import { useState, useRef, useCallback } from 'react';
import { Upload, X, CheckCircle, AlertCircle, Loader2, FileText } from 'lucide-react';
import { Button } from '@/components/design-system';
import { ingestApi, HttpError } from '@/lib/api-client';
import type { IngestSourceType } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileDropZoneOptions {
  source_type?: IngestSourceType;
  parser_hint?: string;
}

interface UploadResult {
  upload_id: string;
  filename: string;
  source_type: IngestSourceType;
  status: string;
}

type DropZoneState =
  | { status: 'idle' }
  | { status: 'dragging' }
  | { status: 'selected'; file: File }
  | { status: 'uploading'; file: File; progress: number }
  | { status: 'success'; result: UploadResult; file: File }
  | { status: 'error'; message: string; file?: File };

interface FileDropZoneProps {
  options?: FileDropZoneOptions;
  onUploaded?: (uploadId: string, filename: string) => void;
  onError?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Accepted file types
// ---------------------------------------------------------------------------

const ACCEPTED_MIME = [
  'text/csv',
  'application/csv',
  'application/pdf',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const ACCEPTED_EXTENSIONS = '.csv,.pdf,.txt,.xls,.xlsx';
const MAX_FILE_MB = 100;
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
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const validExts = ['csv', 'pdf', 'txt', 'xls', 'xlsx'];
  if (!ACCEPTED_MIME.includes(file.type) && !validExts.includes(ext)) {
    return `Unsupported format "${file.type || ext}". Accepted: CSV, PDF, TXT, XLS, XLSX.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileDropZone({ options = {}, onUploaded, onError }: FileDropZoneProps) {
  const [state, setState] = useState<DropZoneState>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

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

    // Simulated progress — fetch doesn't expose upload progress events
    let tick = 0;
    const interval = setInterval(() => {
      tick += Math.random() * 12;
      const progress = Math.min(85, tick);
      setState((s) => s.status === 'uploading' ? { ...s, progress } : s);
    }, 250);

    try {
      const result = await ingestApi.upload(file, options);
      clearInterval(interval);
      setState({
        status: 'success',
        result: {
          upload_id: result.upload_id,
          filename: result.filename,
          source_type: result.source_type,
          status: result.status,
        },
        file,
      });
      onUploaded?.(result.upload_id, result.filename);
    } catch (err) {
      clearInterval(interval);
      let message = 'Upload failed';
      if (err instanceof HttpError) {
        const body = err.body as { error?: string } | null;
        message = body?.error ?? `Upload failed (${err.status})`;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setState({ status: 'error', message, file });
      onError?.(message);
    }
  }, [state, options, onUploaded, onError]);

  const handleReset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isDragging = state.status === 'dragging';
  const isUploading = state.status === 'uploading';

  if (state.status === 'success') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-[4px] border border-[var(--color-rule)] bg-[#f9f7f4] px-6 py-10 text-center"
        style={{ minHeight: 200 }}
      >
        <CheckCircle size={32} strokeWidth={1.2} className="text-[#5c7a5c]" />
        <div>
          <p className="font-display text-[16px] text-[var(--color-text-body)] mb-1">
            Upload accepted
          </p>
          <p className="font-mono text-[11px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
            {state.result.filename} · {state.result.source_type} · pipeline queued
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
        className="flex flex-col items-center justify-center gap-4 rounded-[4px] border border-[var(--color-rule)] bg-[#faf7f4] px-6 py-10 text-center"
        style={{ minHeight: 200 }}
      >
        <AlertCircle size={32} strokeWidth={1.2} className="text-[#b05040]" />
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
        'flex flex-col items-center justify-center gap-5 rounded-[4px] border-2 border-dashed px-6 py-10 text-center transition-colors duration-150',
        isDragging
          ? 'border-[var(--color-book-cloth)] bg-[#f0ebe4] cursor-copy'
          : state.status === 'selected' || state.status === 'uploading'
            ? 'border-[var(--color-rule)] bg-[#f9f7f4] cursor-default'
            : 'border-[var(--color-rule)] bg-[#faf8f5] hover:bg-[#f5f2ec] cursor-pointer',
      ].join(' ')}
      style={{ minHeight: 200 }}
      role={state.status === 'idle' ? 'button' : undefined}
      tabIndex={state.status === 'idle' ? 0 : undefined}
      aria-label={state.status === 'idle' ? 'Select file to upload' : undefined}
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
          <FileText size={22} strokeWidth={1.4} className="text-[var(--color-book-cloth)]" />
        ) : (
          <Upload size={22} strokeWidth={1.4} className="text-[var(--color-book-cloth)]" />
        )}
      </div>

      {/* Idle copy */}
      {state.status === 'idle' && (
        <div>
          <p className="font-display text-[15px] text-[var(--color-text-body)] mb-1">
            {isDragging ? 'Drop to upload' : 'Drop a file, or click to browse'}
          </p>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            CSV · PDF · TXT · XLS · Max {MAX_FILE_MB} MB
          </p>
        </div>
      )}

      {/* Selected / uploading state */}
      {(state.status === 'selected' || state.status === 'uploading') && (
        <div className="w-full max-w-[340px]">
          {/* File info row */}
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={14} strokeWidth={1.4} className="text-[var(--color-book-cloth)] shrink-0" />
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

          {/* Progress bar */}
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

          {/* Action buttons */}
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
