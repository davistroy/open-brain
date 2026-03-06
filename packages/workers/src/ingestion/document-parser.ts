import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { logger } from '../lib/logger.js'

/**
 * Simple parse result from the ingestion document parser.
 * Distinct from ParsedDocument in services/document-parser.ts which has
 * structured sections and metadata. This is a minimal extraction result.
 */
export interface SimpleParseResult {
  text: string
  /** Number of pages (PDF), if determinable */
  pageCount?: number
}

/**
 * Supported MIME types for document parsing.
 * Maps to the parser implementation used.
 */
export const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc (limited support via mammoth)
  'text/plain',
  'text/markdown',
])

/**
 * Supported file extensions (fallback when MIME type is not available).
 */
export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.txt',
  '.md',
])

/**
 * Determine if a file is supported for document parsing.
 *
 * @param filePath  Absolute path to the file on disk
 * @param mimeType  MIME type from upload (optional — falls back to extension)
 */
export function isSupportedDocument(filePath: string, mimeType?: string): boolean {
  if (mimeType && SUPPORTED_MIME_TYPES.has(mimeType)) return true
  const ext = extname(filePath).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext)
}

/**
 * Extract plain text from a document file.
 *
 * Supported formats:
 * - PDF: uses pdf-parse (Mozilla PDF.js under the hood)
 * - DOCX/DOC: uses mammoth (converts to plain text)
 * - TXT/MD: reads directly (UTF-8)
 *
 * @param filePath  Absolute path to the document file
 * @param mimeType  MIME type hint (optional — falls back to file extension)
 * @returns ParsedDocument with extracted text
 * @throws Error if the format is unsupported or parsing fails
 */
export async function parseDocument(
  filePath: string,
  mimeType?: string,
): Promise<SimpleParseResult> {
  const ext = extname(filePath).toLowerCase()
  const effectiveMime = mimeType ?? ''

  const isPdf =
    effectiveMime === 'application/pdf' || ext === '.pdf'

  const isDocx =
    effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    effectiveMime === 'application/msword' ||
    ext === '.docx' ||
    ext === '.doc'

  const isText =
    effectiveMime === 'text/plain' ||
    effectiveMime === 'text/markdown' ||
    ext === '.txt' ||
    ext === '.md'

  if (isPdf) {
    return parsePdf(filePath)
  }

  if (isDocx) {
    return parseDocx(filePath)
  }

  if (isText) {
    return parseText(filePath)
  }

  throw new Error(
    `Unsupported document format: mimeType=${mimeType ?? 'unknown'}, ext=${ext}`,
  )
}

// ── PDF parsing ────────────────────────────────────────────────────────────────

async function parsePdf(filePath: string): Promise<SimpleParseResult> {
  // Dynamic import to avoid module-level side effects from pdf-parse
  const pdfParse = await import('pdf-parse').then(m => m.default ?? m)

  logger.debug({ filePath }, '[document-parser] parsing PDF')

  const buffer = await readFile(filePath)
  const data = await pdfParse(buffer)

  const text = data.text?.trim() ?? ''

  if (!text) {
    throw new Error('PDF parsed but no text extracted — may be scanned/image-only PDF')
  }

  logger.debug(
    { filePath, pages: data.numpages, chars: text.length },
    '[document-parser] PDF parsed',
  )

  return {
    text,
    pageCount: data.numpages,
  }
}

// ── DOCX parsing ──────────────────────────────────────────────────────────────

async function parseDocx(filePath: string): Promise<SimpleParseResult> {
  const mammoth = await import('mammoth')

  logger.debug({ filePath }, '[document-parser] parsing DOCX')

  const result = await mammoth.extractRawText({ path: filePath })

  const text = result.value?.trim() ?? ''

  if (!text) {
    throw new Error('DOCX parsed but no text extracted — document may be empty or unsupported')
  }

  if (result.messages?.length > 0) {
    logger.debug(
      { filePath, warnings: result.messages.length },
      '[document-parser] DOCX parsed with warnings',
    )
  }

  logger.debug(
    { filePath, chars: text.length },
    '[document-parser] DOCX parsed',
  )

  return { text }
}

// ── Plain text / Markdown parsing ─────────────────────────────────────────────

async function parseText(filePath: string): Promise<SimpleParseResult> {
  logger.debug({ filePath }, '[document-parser] reading text file')

  const content = await readFile(filePath, 'utf-8')
  const text = content.trim()

  logger.debug({ filePath, chars: text.length }, '[document-parser] text file read')

  return { text }
}
