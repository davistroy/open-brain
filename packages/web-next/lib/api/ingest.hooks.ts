/**
 * TanStack Query hooks — ingest domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['ingest', 'uploads', limit?]   — paginated upload list (also exported as
 *                                     INGEST_UPLOADS_QUERY_KEY for cross-component invalidation)
 *   ['ingest', 'upload', id]        — single upload row
 *
 * `INGEST_UPLOADS_QUERY_KEY` is exported so IngestClient (upload handler) can
 * invalidate the list after a successful upload without importing the full hook.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ingestApi } from './ingest'
import type { IngestListParams, IngestUploadOptions } from './ingest'

/** Stable root key used for cross-component cache invalidation. */
export const INGEST_UPLOADS_QUERY_KEY = ['ingest', 'uploads'] as const

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Paginated list of file uploads.
 *
 * Supports `initialData` for RSC pre-fetch and dynamic `refetchInterval`
 * to poll while any upload is pending/processing.
 */
export function useIngestUploads(
  params: IngestListParams = {},
  options?: {
    initialData?: Awaited<ReturnType<typeof ingestApi.list>>
    refetchInterval?: number | false | ((query: { state: { data?: Awaited<ReturnType<typeof ingestApi.list>> } }) => number | false)
  },
) {
  const { limit = 20, ...rest } = params
  return useQuery({
    queryKey: [...INGEST_UPLOADS_QUERY_KEY, limit],
    queryFn: () => ingestApi.list({ limit, ...rest }),
    initialData: options?.initialData,
    refetchInterval: options?.refetchInterval,
    staleTime: 5_000,
  })
}

/** Single file upload row. Skips fetch when id is falsy. */
export function useIngestUpload(id: string) {
  return useQuery({
    queryKey: ['ingest', 'upload', id],
    queryFn: () => ingestApi.get(id),
    enabled: Boolean(id),
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Upload a file via multipart POST.
 * On success, invalidates the uploads list.
 */
export function useUploadFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, opts = {} }: { file: File; opts?: IngestUploadOptions }) =>
      ingestApi.upload(file, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INGEST_UPLOADS_QUERY_KEY })
    },
  })
}

/**
 * Re-enqueue a failed upload for reprocessing.
 * On success, invalidates the uploads list.
 */
export function useReprocessUpload() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => ingestApi.process(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INGEST_UPLOADS_QUERY_KEY })
    },
  })
}

/**
 * Trigger manual inbox scan (no upload required).
 */
export function useIngestProcessNow() {
  return useMutation({
    mutationFn: (source?: Parameters<typeof ingestApi.processNow>[0]) =>
      ingestApi.processNow(source),
  })
}
