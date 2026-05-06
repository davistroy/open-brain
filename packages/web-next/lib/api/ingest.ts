/**
 * ingestApi — file uploads via the /api/v1/ingest/* endpoints (CS3.4).
 * Extracted from api-client.ts. Imports `request`, `buildQueryString`,
 * `getApiBase`, and `HttpError` from `./core`; `getApiBase` + `HttpError` are
 * used directly in `upload()` which bypasses `request()` for FormData multipart.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString, getApiBase, HttpError } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a file_uploads row — mirrors FileUploadStatus in @open-brain/shared */
export type FileUploadStatus = 'pending' | 'processing' | 'parsed' | 'failed'

/** Ingest source type — matches the bind-mount subfolder */
export type IngestSourceType = 'financial' | 'utility'

/** Capture-id + short title snippet joined onto a file upload row */
export interface UploadCaptureSummary {
  id: string
  title_snippet: string
}

/** Single row from GET /api/v1/ingest/uploads */
export interface FileUploadRow {
  id: string
  filename: string
  size_bytes: number
  mime_type: string | null
  source_type: IngestSourceType
  parser_hint: string | null
  destination_path: string
  uploaded_at: string          // ISO 8601
  status: FileUploadStatus
  capture_ids: string[]
  captures: UploadCaptureSummary[]
  error_message: string | null
  processed_at: string | null  // ISO 8601 or null
  duration_ms: number | null
}

/** Paginated list envelope from GET /api/v1/ingest/uploads */
export interface ListUploadsResponse {
  uploads: FileUploadRow[]
  total: number
  limit: number
  offset: number
}

/** Response from POST /api/v1/ingest/upload */
export interface UploadFileResponse {
  upload_id: string
  status: FileUploadStatus
  filename: string
  size_bytes: number
  source_type: IngestSourceType
  parser_hint: string | null
  destination_path: string
  uploaded_at: string          // ISO 8601
}

/** Response from POST /api/v1/ingest/process-now and POST /api/v1/ingest/uploads/:id/process */
export interface ProcessNowResponse {
  source: IngestSourceType
  enqueued: boolean
  message?: string
}

export interface IngestUploadOptions {
  source_type?: IngestSourceType
  parser_hint?: string
}

export interface IngestListParams {
  limit?: number
  offset?: number
  status?: FileUploadStatus
  source_type?: IngestSourceType
}

// ---------------------------------------------------------------------------
// ingestApi
// ---------------------------------------------------------------------------

export const ingestApi = {
  /**
   * POST /api/v1/ingest/upload — multipart file upload.
   * Streams FormData (field name: `file`). Does NOT set Content-Type — browser
   * sets it with the boundary automatically. Returns 201 with upload_id.
   */
  upload: async (file: File, opts: IngestUploadOptions = {}): Promise<UploadFileResponse> => {
    const formData = new FormData()
    formData.append('file', file, file.name)
    if (opts.source_type) formData.append('source_type', opts.source_type)
    if (opts.parser_hint) formData.append('parser_hint', opts.parser_hint)

    const url = `${getApiBase()}/ingest/upload`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type — browser sets it with multipart boundary
        'X-Open-Brain-Caller': 'web-ui',
      },
      body: formData,
    })

    if (!response.ok) {
      let body: unknown
      const contentType = response.headers.get('content-type') ?? ''
      try {
        body = contentType.includes('application/json')
          ? await response.json()
          : await response.text()
      } catch {
        body = null
      }
      throw new HttpError(response.status, body, '/ingest/upload')
    }

    return response.json() as Promise<UploadFileResponse>
  },

  /**
   * GET /api/v1/ingest/uploads — paginated list of file upload rows.
   */
  list: (params: IngestListParams = {}): Promise<ListUploadsResponse> => {
    const qs = buildQueryString(params)
    return request<ListUploadsResponse>(`/ingest/uploads${qs}`)
  },

  /**
   * GET /api/v1/ingest/uploads/:id — single file upload row.
   */
  get: (id: string): Promise<FileUploadRow> => {
    return request<FileUploadRow>(`/ingest/uploads/${encodeURIComponent(id)}`)
  },

  /**
   * POST /api/v1/ingest/uploads/:id/process — re-enqueue a specific upload for processing.
   * Used to retry failed uploads. Returns 200 with enqueued: true on success.
   */
  process: (id: string): Promise<ProcessNowResponse> => {
    return request<ProcessNowResponse>(
      `/ingest/uploads/${encodeURIComponent(id)}/process`,
      { method: 'POST' },
    )
  },

  /**
   * POST /api/v1/ingest/process-now — manual inbox re-trigger (no upload required).
   * Fans out a synthetic job per source so the worker can scan the sidecar inbox.
   */
  processNow: (source?: IngestSourceType): Promise<ProcessNowResponse> => {
    const qs = source ? buildQueryString({ source }) : ''
    return request<ProcessNowResponse>(`/ingest/process-now${qs}`, { method: 'POST' })
  },
}
