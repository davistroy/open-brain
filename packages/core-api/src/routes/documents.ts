import { tmpdir } from 'node:os'
import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { ValidationError } from '@open-brain/shared'
import type { CaptureService } from '../services/capture.js'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { Queue } from 'bullmq'

/**
 * Supported document MIME types mapped to canonical extension.
 * Text extraction happens asynchronously in the document-pipeline worker.
 */
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
}

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.md', '.txt', '.html', '.htm'])

const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
}

/** Maximum batch size to prevent unbounded memory usage. */
const MAX_BATCH_SIZE = 100

/**
 * Resolve the effective MIME type, preferring extension-based detection
 * over potentially unreliable browser-reported Content-Type.
 */
function resolveMimeType(filename: string, reportedType: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (EXT_TO_MIME[ext]) return EXT_TO_MIME[ext]
  if (reportedType && reportedType !== 'application/octet-stream' && MIME_TO_EXT[reportedType]) {
    return reportedType
  }
  return reportedType || 'application/octet-stream'
}

function isSupportedFile(filename: string, mimeType: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext) || Boolean(MIME_TO_EXT[mimeType])
}

/** Validate a MIME type string (basic format check). */
function isValidMimeType(mime: string): boolean {
  return /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime)
}

/** Job data shape — matches packages/workers/src/queues/document-pipeline.ts */
interface DocumentPipelineJobData {
  captureId: string
}

/** File-specific source_metadata fields for file ingestion. */
export interface FileSourceMetadata {
  original_path: string
  file_size?: number
  mime_type: string
  modified_date?: string
  content_hash?: string
  category?: string
  subcategory?: string
  taxonomy_path?: string
  [key: string]: unknown
}

/** Batch ingestion request item. */
export interface BatchFileReference {
  title: string
  original_path: string
  mime_type: string
  file_size?: number
  modified_date?: string
  content_hash?: string
  category?: string
  subcategory?: string
  taxonomy_path?: string
  brain_view?: string
  tags?: string[]
  content?: string
}

/** Batch ingestion result for a single item. */
interface BatchResultItem {
  index: number
  capture_id?: string
  pipeline_status?: string
  error?: string
}

/**
 * Register document routes:
 *   POST /api/v1/documents — multipart document upload (existing)
 *   POST /api/v1/documents/batch — JSON batch ingestion for file references
 *
 * The upload endpoint accepts multipart/form-data with:
 *   - file        (required) — PDF, DOCX, MD, TXT, or HTML
 *   - brain_view  (optional) — defaults to 'technical'
 *   - tags        (optional) — comma-separated string
 *   - title       (optional) — title override; replaces auto-derived name
 *   - source      (optional) — 'document' (default) or 'file'
 *   - source_metadata (optional) — JSON string with file-specific fields:
 *       original_path, file_size, mime_type, modified_date, content_hash,
 *       category, subcategory, taxonomy_path
 *
 * The uploaded file is saved to a system temp directory under
 * `open-brain-uploads/<captureId>.<ext>` so the document-pipeline worker
 * can access it via `source_metadata.file_path`.
 *
 * Response 201: { capture_id, filename, mime_type, pipeline_status, brain_view, tags }
 */
export function registerDocumentRoutes(
  app: Hono,
  captureService: CaptureService,
  configService: ConfigService,
  documentPipelineQueue?: Queue<DocumentPipelineJobData>,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/v1/documents — single file upload (multipart/form-data)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/v1/documents', async (c) => {
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      throw new ValidationError('Request must be multipart/form-data')
    }

    // ── Validate file field ─────────────────────────────────────────────────
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      throw new ValidationError('Missing required field: file')
    }

    const originalFilename = file.name || 'untitled'
    const mimeType = resolveMimeType(originalFilename, file.type || '')

    if (!isSupportedFile(originalFilename, mimeType)) {
      const ext = originalFilename.includes('.')
        ? originalFilename.slice(originalFilename.lastIndexOf('.'))
        : '(none)'
      throw new ValidationError(
        `Unsupported file type: ${ext}. Supported formats: PDF, DOCX, DOC, MD, TXT, HTML`,
      )
    }

    // ── Parse optional fields ───────────────────────────────────────────────
    const rawBrainView = formData.get('brain_view')
    const brainView = typeof rawBrainView === 'string' && rawBrainView.trim()
      ? rawBrainView.trim()
      : 'technical'

    const rawTags = formData.get('tags')
    const tags = typeof rawTags === 'string' && rawTags.trim()
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : []

    const rawTitle = formData.get('title')
    const titleOverride = typeof rawTitle === 'string' && rawTitle.trim()
      ? rawTitle.trim()
      : null

    // ── Parse optional source override ──────────────────────────────────────
    const rawSource = formData.get('source')
    const source: 'document' | 'file' =
      typeof rawSource === 'string' && rawSource.trim() === 'file' ? 'file' : 'document'

    // ── Parse optional source_metadata (JSON string) ────────────────────────
    const rawSourceMeta = formData.get('source_metadata')
    let extraSourceMeta: Record<string, unknown> = {}
    if (typeof rawSourceMeta === 'string' && rawSourceMeta.trim()) {
      try {
        const parsed = JSON.parse(rawSourceMeta.trim())
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          extraSourceMeta = parsed as Record<string, unknown>
        }
      } catch {
        throw new ValidationError('source_metadata must be valid JSON')
      }
    }

    // ── Validate brain_view ─────────────────────────────────────────────────
    const validViews = configService.getBrainViews()
    if (!validViews.includes(brainView)) {
      throw new ValidationError(
        `Invalid brain_view: ${brainView}. Valid values: ${validViews.join(', ')}`,
      )
    }

    // ── Save file to temp directory ─────────────────────────────────────────
    // The document-pipeline worker reads the file from this path via
    // source_metadata.file_path. It is responsible for cleanup after extraction.
    const uploadId = randomUUID()
    const ext = originalFilename.includes('.')
      ? originalFilename.slice(originalFilename.lastIndexOf('.'))
      : ''
    const uploadDir = join(tmpdir(), 'open-brain-uploads')
    const filePath = join(uploadDir, `${uploadId}${ext}`)

    try {
      try {
        await mkdir(uploadDir, { recursive: true })
        const buffer = await file.arrayBuffer()
        await writeFile(filePath, Buffer.from(buffer))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ filename: originalFilename, err: msg }, '[documents] failed to save uploaded file')
        throw new Error(`Failed to store uploaded file: ${msg}`)
      }

      // ── Derive capture content (title or filename) ──────────────────────────
      const documentName = titleOverride
        ?? originalFilename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      const captureContent = `[Document] ${documentName}`

      // ── Build merged source_metadata ──────────────────────────────────────
      const sourceMetadata = {
        ...extraSourceMeta,
        filename: originalFilename,
        mime_type: mimeType,
        title: documentName,
        file_path: filePath,
        upload_status: 'pending_extraction',
      }

      // ── Create the capture ──────────────────────────────────────────────────
      const capture = await captureService.create({
        content: captureContent,
        capture_type: 'observation',
        brain_view: brainView,
        source,
        metadata: {
          source_metadata: sourceMetadata,
          tags,
        },
      })

      // ── Enqueue document-pipeline job ───────────────────────────────────────
      if (documentPipelineQueue) {
        try {
          await documentPipelineQueue.add(
            'document-pipeline',
            { captureId: capture.id },
            { jobId: `document_${capture.id}` },
          )
          logger.info(
            { captureId: capture.id, filename: originalFilename, filePath },
            '[documents] document-pipeline job enqueued',
          )
        } catch (err) {
          // Enqueue failure must not fail the upload — daily sweep or manual retry
          // can re-trigger the pipeline. The capture and file are already persisted.
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(
            { captureId: capture.id, filename: originalFilename, err: msg },
            '[documents] failed to enqueue document-pipeline job — capture created, pipeline pending',
          )
        }
      } else {
        logger.warn(
          { captureId: capture.id },
          '[documents] document-pipeline queue not configured — capture created without pipeline job',
        )
      }

      return c.json(
        {
          capture_id: capture.id,
          filename: originalFilename,
          mime_type: mimeType,
          pipeline_status: capture.pipeline_status,
          brain_view: capture.brain_view,
          tags: capture.tags,
        },
        201,
      )
    } finally {
      await unlink(filePath).catch(() => {})
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/v1/documents/batch — bulk file reference ingestion (JSON)
  // ─────────────────────────────────────────────────────────────────────────
  // Accepts JSON body: { files: BatchFileReference[] }
  // Each file reference creates a capture with source='file' and rich
  // source_metadata. The actual file content may be provided inline via the
  // `content` field, or the document-pipeline worker fetches it from
  // `original_path` in source_metadata.
  //
  // Response 201: { queued: number, errors: number, results: BatchResultItem[] }
  app.post('/api/v1/documents/batch', async (c) => {
    let body: { files?: unknown }
    try {
      body = await c.req.json()
    } catch {
      throw new ValidationError('Request body must be valid JSON')
    }

    if (!body.files || !Array.isArray(body.files)) {
      throw new ValidationError('Missing required field: files (must be an array)')
    }

    const files = body.files as unknown[]
    if (files.length === 0) {
      throw new ValidationError('files array must not be empty')
    }
    if (files.length > MAX_BATCH_SIZE) {
      throw new ValidationError(
        `Batch too large: ${files.length} items. Maximum is ${MAX_BATCH_SIZE}.`,
      )
    }

    const validViews = configService.getBrainViews()
    const results: BatchResultItem[] = []
    let queued = 0
    let errors = 0

    for (let i = 0; i < files.length; i++) {
      const item = files[i]
      if (!item || typeof item !== 'object') {
        results.push({ index: i, error: 'Invalid item: must be an object' })
        errors++
        continue
      }

      const ref = item as Record<string, unknown>

      // ── Validate required fields ────────────────────────────────────────
      if (typeof ref.title !== 'string' || !ref.title.trim()) {
        results.push({ index: i, error: 'Missing required field: title' })
        errors++
        continue
      }
      if (typeof ref.original_path !== 'string' || !ref.original_path.trim()) {
        results.push({ index: i, error: 'Missing required field: original_path' })
        errors++
        continue
      }
      if (typeof ref.mime_type !== 'string' || !ref.mime_type.trim()) {
        results.push({ index: i, error: 'Missing required field: mime_type' })
        errors++
        continue
      }
      if (!isValidMimeType(ref.mime_type as string)) {
        results.push({ index: i, error: `Invalid mime_type: ${ref.mime_type}` })
        errors++
        continue
      }

      // ── Validate optional fields ────────────────────────────────────────
      const brainView = typeof ref.brain_view === 'string' && ref.brain_view.trim()
        ? ref.brain_view.trim()
        : 'technical'
      if (!validViews.includes(brainView)) {
        results.push({
          index: i,
          error: `Invalid brain_view: ${brainView}. Valid values: ${validViews.join(', ')}`,
        })
        errors++
        continue
      }

      const tags = Array.isArray(ref.tags) && ref.tags.every((t: unknown) => typeof t === 'string')
        ? (ref.tags as string[])
        : []

      const title = (ref.title as string).trim()
      const contentText = typeof ref.content === 'string' && ref.content.trim()
        ? ref.content.trim()
        : `[Document] ${title}`

      // ── Build file source_metadata ──────────────────────────────────────
      const fileSourceMeta: Record<string, unknown> = {
        original_path: (ref.original_path as string).trim(),
        mime_type: (ref.mime_type as string).trim(),
        title,
        upload_status: 'pending_extraction',
      }
      if (typeof ref.file_size === 'number' && ref.file_size >= 0) {
        fileSourceMeta.file_size = ref.file_size
      }
      if (typeof ref.modified_date === 'string' && ref.modified_date.trim()) {
        fileSourceMeta.modified_date = ref.modified_date.trim()
      }
      if (typeof ref.content_hash === 'string' && ref.content_hash.trim()) {
        fileSourceMeta.content_hash = ref.content_hash.trim()
      }
      if (typeof ref.category === 'string' && ref.category.trim()) {
        fileSourceMeta.category = ref.category.trim()
      }
      if (typeof ref.subcategory === 'string' && ref.subcategory.trim()) {
        fileSourceMeta.subcategory = ref.subcategory.trim()
      }
      if (typeof ref.taxonomy_path === 'string' && ref.taxonomy_path.trim()) {
        fileSourceMeta.taxonomy_path = ref.taxonomy_path.trim()
      }

      // ── Create capture ──────────────────────────────────────────────────
      try {
        const capture = await captureService.create({
          content: contentText,
          capture_type: 'observation',
          brain_view: brainView,
          source: 'file',
          metadata: {
            source_metadata: fileSourceMeta,
            tags,
          },
        })

        // ── Enqueue for pipeline processing ─────────────────────────────
        if (documentPipelineQueue) {
          try {
            await documentPipelineQueue.add(
              'document-pipeline',
              { captureId: capture.id },
              { jobId: `document_${capture.id}` },
            )
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn(
              { captureId: capture.id, title, err: msg },
              '[documents/batch] failed to enqueue pipeline job — capture created',
            )
          }
        }

        results.push({
          index: i,
          capture_id: capture.id,
          pipeline_status: capture.pipeline_status,
        })
        queued++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ index: i, title, err: msg }, '[documents/batch] failed to create capture')
        results.push({ index: i, error: msg })
        errors++
      }
    }

    return c.json({ queued, errors, results }, 201)
  })
}
