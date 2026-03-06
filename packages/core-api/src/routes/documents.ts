import { tmpdir } from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { ValidationError } from '@open-brain/shared'
import type { CaptureService } from '../services/capture.js'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
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

/** Job data shape — matches packages/workers/src/queues/document-pipeline.ts */
interface DocumentPipelineJobData {
  captureId: string
}

/**
 * Register POST /api/v1/documents — multipart document upload endpoint.
 *
 * Accepts multipart/form-data with:
 *   - file        (required) — PDF, DOCX, MD, TXT, or HTML
 *   - brain_view  (optional) — defaults to 'technical'
 *   - tags        (optional) — comma-separated string
 *   - title       (optional) — title override; replaces auto-derived name
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

    // ── Create the capture ──────────────────────────────────────────────────
    // source='document'; actual text is extracted async.
    const capture = await captureService.create({
      content: captureContent,
      capture_type: 'observation',
      brain_view: brainView,
      source: 'document',
      metadata: {
        source_metadata: {
          filename: originalFilename,
          mime_type: mimeType,
          title: documentName,
          file_path: filePath,
          upload_status: 'pending_extraction',
        },
        tags,
      },
    })

    // ── Enqueue document-pipeline job ───────────────────────────────────────
    if (documentPipelineQueue) {
      try {
        await documentPipelineQueue.add(
          'document-pipeline',
          { captureId: capture.id },
          { jobId: `document:${capture.id}` },
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
  })
}
