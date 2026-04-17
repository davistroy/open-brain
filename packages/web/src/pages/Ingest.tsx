/**
 * Ingest — unified drop-anything upload page.
 *
 * Drop CSVs, HTML exports, PDFs, images, or text files. The core-api classifies
 * the file (or uses an optional manual override) and routes it to the right
 * sidecar (financial, utility, document, image, email, other). Uploads stream
 * through ingest SSE events so the UI reflects pending → processing → completed
 * without polling.
 *
 * Top-right controls let you force a source type (`auto` lets the backend
 * classify) and kick all configured sidecars via `POST /ingest/process-now`.
 * Below the drop zone, the 20 most-recent uploads are shown in a compact table;
 * clicking a row opens a details dialog with a Re-process button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { FileDropZone } from '@/components/FileDropZone'
import { ingestApi } from '@/lib/api'
import type {
  FileUploadRow,
  FileUploadStatus,
  IngestSourceType,
} from '@/lib/api'
import { cn } from '@/lib/utils'

// --- Config ---

type SourceTypeChoice = 'auto' | IngestSourceType

const SOURCE_TYPE_OPTIONS: SourceTypeChoice[] = [
  'auto',
  'financial',
  'utility',
  'document',
  'image',
  'email',
  'other',
]

const ACCEPT_MAP = {
  'text/csv': ['.csv'],
  'text/html': ['.html', '.htm'],
  'application/pdf': ['.pdf'],
  'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  'text/*': ['.txt', '.md'],
}

const MAX_SIZE = 25 * 1024 * 1024 // 25 MB

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

// --- Types ---

/**
 * Per-file upload tracking state. `tempKey` is a client-side ID used before the
 * server assigns an `upload_id`; once the upload resolves, `row` carries the
 * authoritative server record and SSE events flow into it.
 */
interface UploadTracker {
  tempKey: string
  filename: string
  size: number
  status: FileUploadStatus | 'starting' | 'error'
  row: FileUploadRow | null
  errorMessage?: string
}

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

function statusPercent(status: FileUploadStatus | 'starting' | 'error'): number {
  switch (status) {
    case 'starting':
      return 10
    case 'pending':
      return 25
    case 'processing':
      return 50
    case 'completed':
      return 100
    case 'failed':
    case 'error':
      return 100
    default:
      return 0
  }
}

function statusBadgeVariant(status: FileUploadStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default'
    case 'processing':
      return 'secondary'
    case 'pending':
      return 'outline'
    case 'failed':
      return 'destructive'
    default:
      return 'outline'
  }
}

function captureLinkFor(source: IngestSourceType, captureId: string): string {
  if (source === 'financial') return `/financial?capture=${captureId}`
  return `/timeline?capture=${captureId}`
}

// --- Component ---

export function Ingest() {
  // Source type override (top-right control)
  const [sourceType, setSourceType] = useState<SourceTypeChoice>('auto')

  // In-flight / recently-completed upload trackers (keyed by tempKey)
  const [trackers, setTrackers] = useState<UploadTracker[]>([])

  // Recent uploads table
  const [recent, setRecent] = useState<FileUploadRow[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState<string | null>(null)

  // Dialog state
  const [detail, setDetail] = useState<FileUploadRow | null>(null)
  const [reprocessing, setReprocessing] = useState(false)

  // Process-now button feedback
  const [processingNow, setProcessingNow] = useState(false)
  const [statusMessage, setStatusMessage] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null)

  // Map of tempKey -> unsubscribe function for SSE
  const unsubsRef = useRef<Map<string, () => void>>(new Map())

  // --- Fetch recent uploads ---

  const fetchRecent = useCallback(async () => {
    setRecentLoading(true)
    setRecentError(null)
    try {
      const res = await ingestApi.list({ limit: 20 })
      setRecent(res.uploads ?? [])
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : 'Failed to load uploads')
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRecent()
  }, [fetchRecent])

  // Clean up SSE subscriptions on unmount
  useEffect(() => {
    const unsubs = unsubsRef.current
    return () => {
      for (const unsub of unsubs.values()) {
        try {
          unsub()
        } catch {
          // ignore
        }
      }
      unsubs.clear()
    }
  }, [])

  // --- Upload handler ---

  const handleFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempKey = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        // Add starting tracker
        setTrackers((prev) => [
          ...prev,
          {
            tempKey,
            filename: file.name,
            size: file.size,
            status: 'starting',
            row: null,
          },
        ])

        // Fire upload
        const opts = sourceType === 'auto' ? undefined : { source_type: sourceType }
        ingestApi
          .upload(file, opts)
          .then((res) => {
            // Seed tracker with the server-assigned upload id and subscribe to SSE.
            setTrackers((prev) =>
              prev.map((t) =>
                t.tempKey === tempKey
                  ? {
                      ...t,
                      status: res.status,
                      row: {
                        id: res.upload_id,
                        filename: res.filename,
                        size_bytes: res.size_bytes,
                        mime_type: null,
                        source_type: res.source_type,
                        parser_hint: res.parser_hint,
                        destination_path: res.destination_path,
                        uploaded_at: res.uploaded_at,
                        status: res.status,
                        capture_ids: [],
                        captures: [],
                        error_message: null,
                        processed_at: null,
                        duration_ms: null,
                      },
                    }
                  : t,
              ),
            )

            // Subscribe to status events for this upload
            const unsub = ingestApi.subscribeToEvents(res.upload_id, (row) => {
              setTrackers((prev) =>
                prev.map((t) =>
                  t.tempKey === tempKey
                    ? {
                        ...t,
                        status: row.status,
                        row,
                        errorMessage: row.error_message ?? undefined,
                      }
                    : t,
                ),
              )
              if (row.status === 'completed' || row.status === 'failed') {
                // Refresh the recent uploads list to reflect server-side state
                void fetchRecent()
              }
            })
            unsubsRef.current.set(tempKey, unsub)
          })
          .catch((err) => {
            setTrackers((prev) =>
              prev.map((t) =>
                t.tempKey === tempKey
                  ? {
                      ...t,
                      status: 'error',
                      errorMessage: err instanceof Error ? err.message : 'Upload failed',
                    }
                  : t,
              ),
            )
          })
      }
    },
    [sourceType, fetchRecent],
  )

  // --- Process-now handler ---

  const handleProcessNow = useCallback(async () => {
    setProcessingNow(true)
    setStatusMessage(null)
    try {
      const res = await ingestApi.processNow()
      setStatusMessage({
        kind: 'success',
        text: res.message ?? `Triggered ingest sidecars${res.enqueued ? '' : ' (no sidecars enqueued)'}`,
      })
      void fetchRecent()
    } catch (err) {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to trigger process-now',
      })
    } finally {
      setProcessingNow(false)
    }
  }, [fetchRecent])

  // --- Re-process handler (from detail dialog) ---

  const handleReprocess = useCallback(
    async (id: string) => {
      setReprocessing(true)
      try {
        await ingestApi.process(id)
        setStatusMessage({ kind: 'success', text: 'Re-queued for processing' })
        setDetail(null)
        void fetchRecent()
      } catch (err) {
        setStatusMessage({
          kind: 'error',
          text: err instanceof Error ? err.message : 'Failed to re-process',
        })
      } finally {
        setReprocessing(false)
      }
    },
    [fetchRecent],
  )

  // --- Render helpers ---

  const activeTrackers = useMemo(
    () =>
      trackers.filter(
        (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'error',
      ),
    [trackers],
  )
  const finishedTrackers = useMemo(
    () =>
      trackers.filter(
        (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'error',
      ),
    [trackers],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ingest</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Drop CSVs, HTML exports, PDFs. We classify and route automatically.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Force source type</span>
            <select
              className={SELECT_CLASS}
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as SourceTypeChoice)}
              aria-label="Force source type"
            >
              {SOURCE_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt === 'auto' ? 'auto (classify)' : opt}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="outline"
            size="sm"
            onClick={handleProcessNow}
            disabled={processingNow}
          >
            {processingNow ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Process inbox now
          </Button>
        </div>
      </div>

      {/* Status banner (process-now / re-process feedback) */}
      {statusMessage && (
        <div
          role="status"
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            statusMessage.kind === 'success'
              ? 'border-border bg-muted text-foreground'
              : 'border-destructive bg-destructive/10 text-destructive',
          )}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Drop zone */}
      <FileDropZone
        accept={ACCEPT_MAP}
        maxSizeBytes={MAX_SIZE}
        multiple
        onFiles={handleFiles}
        label="Drop files here or click to browse"
        sublabel="CSV, HTML, PDF, images, text — up to 25 MB per file"
      />

      {/* Active uploads */}
      {activeTrackers.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Uploading</h2>
          {activeTrackers.map((t) => (
            <div key={t.tempKey} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate max-w-[60%]">{t.filename}</span>
                <span>
                  {formatBytes(t.size)} · {t.status}
                </span>
              </div>
              <Progress value={statusPercent(t.status)} />
            </div>
          ))}
        </Card>
      )}

      {/* Recently finished uploads in this session — result pills */}
      {finishedTrackers.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Just finished</h2>
          <ul className="space-y-2">
            {finishedTrackers.map((t) => {
              const row = t.row
              const isError = t.status === 'failed' || t.status === 'error'
              return (
                <li
                  key={t.tempKey}
                  className="flex items-center gap-2 flex-wrap text-sm border border-border rounded-md px-3 py-2 bg-background"
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate max-w-[28ch]">{t.filename}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(t.size)}</span>

                  {row && (
                    <Badge variant={statusBadgeVariant(row.status)} className="capitalize">
                      {row.status}
                    </Badge>
                  )}
                  {!row && isError && (
                    <Badge variant="destructive">error</Badge>
                  )}

                  {row && (
                    <Badge variant="outline" className="capitalize">
                      {row.source_type}
                    </Badge>
                  )}

                  {row?.captures.map((cap) => (
                    <a
                      key={cap.id}
                      href={captureLinkFor(row.source_type, cap.id)}
                      className="text-xs rounded-full border border-border px-2 py-0.5 text-foreground hover:bg-muted"
                      title={cap.title_snippet}
                    >
                      {cap.title_snippet.slice(0, 40) || cap.id.slice(0, 8)}
                    </a>
                  ))}

                  {isError && t.errorMessage && (
                    <span className="text-xs text-destructive ml-auto">
                      {t.errorMessage}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {/* Recent uploads table */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Recent uploads</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchRecent()}
            disabled={recentLoading}
            aria-label="Refresh recent uploads"
          >
            {recentLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>

        {recentError && (
          <p className="text-sm text-destructive py-2">{recentError}</p>
        )}

        {!recentError && recent.length === 0 && !recentLoading && (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No uploads yet. Drop a file above to get started.
          </p>
        )}

        {recent.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Filename</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Uploaded</th>
                  <th className="py-2 pr-3 font-medium">Captures</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border last:border-b-0 hover:bg-muted cursor-pointer"
                    onClick={() => setDetail(row)}
                  >
                    <td className="py-2 pr-3 truncate max-w-[30ch]">{row.filename}</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {formatBytes(row.size_bytes)}
                    </td>
                    <td className="py-2 pr-3 capitalize text-muted-foreground">
                      {row.source_type}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={statusBadgeVariant(row.status)} className="capitalize">
                        {row.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {relativeTime(row.uploaded_at)}
                    </td>
                    <td className="py-2 pr-3">
                      {row.captures.length > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                          {row.captures.length}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{detail?.filename}</DialogTitle>
            <DialogDescription>
              {detail &&
                `${formatBytes(detail.size_bytes)} · ${detail.source_type} · uploaded ${relativeTime(
                  detail.uploaded_at,
                )}`}
            </DialogDescription>
          </DialogHeader>

          {detail && (
            <pre className="max-h-[50vh] overflow-auto rounded-md border border-border bg-muted p-3 text-xs text-foreground">
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
            {detail && (
              <Button
                onClick={() => void handleReprocess(detail.id)}
                disabled={reprocessing}
              >
                {reprocessing ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                Re-process
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Ingest
