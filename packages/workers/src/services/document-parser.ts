import path from 'node:path'
import { logger } from '../lib/logger.js'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type SupportedFormat = 'pdf' | 'docx' | 'md' | 'txt' | 'html'

export interface DocumentSection {
  /** Heading text, if extracted */
  heading: string
  /** Body text of this section */
  content: string
  /** Nesting level (1 = H1, 2 = H2, etc.) */
  level: number
}

export interface ParsedDocument {
  /** Inferred or extracted document title */
  title: string
  /** Full plain-text content (all sections concatenated) */
  text: string
  /** Detected format */
  format: SupportedFormat
  /** Structured sections with headings, when available */
  sections: DocumentSection[]
  /** Extracted metadata */
  metadata: DocumentMetadata
}

export interface DocumentMetadata {
  author?: string
  /** ISO-8601 string or undefined */
  created_date?: string
  word_count: number
  /** Source file name (no directory) */
  filename: string
  /** Absolute path to source file */
  filepath: string
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Detect format from file extension. Throws if unsupported. */
export function detectFormat(filePath: string): SupportedFormat {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.pdf':
      return 'pdf'
    case '.docx':
      return 'docx'
    case '.md':
    case '.markdown':
      return 'md'
    case '.txt':
      return 'txt'
    case '.html':
    case '.htm':
      return 'html'
    default:
      throw new Error(`Unsupported file extension: ${ext}`)
  }
}

/** Count words in a plain-text string (whitespace split). */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Infer a document title from the file stem when no title is available
 * in the document itself.
 *
 * e.g. "my-document_v2.pdf" → "My Document V2"
 */
function inferTitleFromFilename(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath))
  return stem
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Extract sections from Markdown text.
 *
 * Headings recognised: ATX style (# H1, ## H2, …).
 * Returns a single section with the whole text when no headings are found.
 */
function parseMdSections(text: string): DocumentSection[] {
  const lines = text.split('\n')
  const sections: DocumentSection[] = []
  let currentHeading = ''
  let currentLevel = 0
  let bodyLines: string[] = []

  const flush = () => {
    const content = bodyLines.join('\n').trim()
    if (content || currentHeading) {
      sections.push({ heading: currentHeading, content, level: currentLevel })
    }
    bodyLines = []
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      flush()
      currentLevel = headingMatch[1].length
      currentHeading = headingMatch[2].trim()
    } else {
      bodyLines.push(line)
    }
  }
  flush()

  // If nothing was parsed into sections, wrap the whole text in one section
  if (sections.length === 0) {
    sections.push({ heading: '', content: text.trim(), level: 0 })
  }

  return sections
}

/**
 * Strip common HTML tags and return plain text.
 * Used for HTML and as a light fallback for other formats.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract H1-H6 sections from raw HTML for structured section output.
 * Falls back gracefully when no headings are present.
 */
function parseHtmlSections(html: string, plainText: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  // Split on heading tags
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi
  const parts = html.split(headingRe)

  // parts layout: [before-first-heading, level, heading-html, body-html, level, heading-html, body-html, …]
  // When no headings found, parts.length === 1
  if (parts.length === 1) {
    return [{ heading: '', content: plainText, level: 0 }]
  }

  // Pre-heading content
  const beforeFirst = stripHtml(parts[0])
  if (beforeFirst) {
    sections.push({ heading: '', content: beforeFirst, level: 0 })
  }

  for (let i = 1; i < parts.length; i += 3) {
    const level = parseInt(parts[i], 10)
    const headingText = stripHtml(parts[i + 1])
    const bodyHtml = parts[i + 2] ?? ''
    const content = stripHtml(bodyHtml)
    sections.push({ heading: headingText, content, level })
  }

  return sections.filter((s) => s.heading || s.content)
}

// ────────────────────────────────────────────────────────────────────────────
// Format-specific parsers
// ────────────────────────────────────────────────────────────────────────────

async function parsePdf(fileBuffer: Buffer, filePath: string): Promise<ParsedDocument> {
  // Dynamic import keeps pdf-parse out of the module scope so tests can mock it
  const pdfParse = (await import('pdf-parse')).default

  const result = await pdfParse(fileBuffer)
  const text = result.text.trim()

  // pdf-parse exposes info.Author, info.Title, and info.CreationDate
  const info = (result.info as Record<string, unknown>) ?? {}
  const author = typeof info.Author === 'string' && info.Author ? info.Author : undefined
  const rawTitle = typeof info.Title === 'string' && info.Title ? info.Title.trim() : ''
  const title = rawTitle || inferTitleFromFilename(filePath)

  let created_date: string | undefined
  if (typeof info.CreationDate === 'string' && info.CreationDate) {
    try {
      // PDF date format: "D:YYYYMMDDHHmmSSOHH'mm'" — parse the date part
      const raw = info.CreationDate.replace(/^D:/, '')
      const year = raw.slice(0, 4)
      const month = raw.slice(4, 6)
      const day = raw.slice(6, 8)
      if (year && month && day) {
        created_date = new Date(`${year}-${month}-${day}`).toISOString()
      }
    } catch {
      // ignore malformed dates
    }
  }

  // PDF text is flat — no heading structure available
  const sections: DocumentSection[] = [{ heading: '', content: text, level: 0 }]

  return {
    title,
    text,
    format: 'pdf',
    sections,
    metadata: {
      author,
      created_date,
      word_count: countWords(text),
      filename: path.basename(filePath),
      filepath: filePath,
    },
  }
}

async function parseDocx(fileBuffer: Buffer, filePath: string): Promise<ParsedDocument> {
  const mammoth = await import('mammoth')

  // Extract as HTML to preserve heading structure, then also get plain text
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml({ buffer: fileBuffer }),
    mammoth.extractRawText({ buffer: fileBuffer }),
  ])

  const html = htmlResult.value
  const text = textResult.value.trim()

  // Attempt to extract title from first H1 in HTML
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const rawTitle = h1Match ? stripHtml(h1Match[1]).trim() : ''
  const title = rawTitle || inferTitleFromFilename(filePath)

  const sections = parseHtmlSections(html, text)

  return {
    title,
    text,
    format: 'docx',
    sections,
    metadata: {
      word_count: countWords(text),
      filename: path.basename(filePath),
      filepath: filePath,
    },
  }
}

function parseMarkdown(fileContent: string, filePath: string): ParsedDocument {
  const text = fileContent.trim()
  const sections = parseMdSections(text)

  // Title: first ATX H1 heading, or filename
  const h1Section = sections.find((s) => s.level === 1)
  const title = h1Section?.heading || inferTitleFromFilename(filePath)

  return {
    title,
    text,
    format: 'md',
    sections,
    metadata: {
      word_count: countWords(text),
      filename: path.basename(filePath),
      filepath: filePath,
    },
  }
}

function parsePlainText(fileContent: string, filePath: string): ParsedDocument {
  const text = fileContent.trim()
  // First non-empty line is a reasonable title guess
  const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
  const title = firstLine.slice(0, 120).trim() || inferTitleFromFilename(filePath)

  return {
    title,
    text,
    format: 'txt',
    sections: [{ heading: '', content: text, level: 0 }],
    metadata: {
      word_count: countWords(text),
      filename: path.basename(filePath),
      filepath: filePath,
    },
  }
}

function parseHtml(fileContent: string, filePath: string): ParsedDocument {
  const text = stripHtml(fileContent)
  const sections = parseHtmlSections(fileContent, text)

  // Title: <title> tag or first H1, or filename
  const titleTagMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(fileContent)
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(fileContent)
  const rawTitle = titleTagMatch
    ? stripHtml(titleTagMatch[1]).trim()
    : h1Match
      ? stripHtml(h1Match[1]).trim()
      : ''
  const title = rawTitle || inferTitleFromFilename(filePath)

  return {
    title,
    text,
    format: 'html',
    sections,
    metadata: {
      word_count: countWords(text),
      filename: path.basename(filePath),
      filepath: filePath,
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DocumentParserService
// ────────────────────────────────────────────────────────────────────────────

/**
 * DocumentParserService — extracts text, metadata, and optional section
 * structure from PDF, DOCX, Markdown, plain text, and HTML files.
 *
 * Design decisions:
 * - PDF uses pdf-parse (pure JS, no native binary required)
 * - DOCX uses mammoth (preserves heading structure via HTML intermediate)
 * - MD/TXT/HTML use built-in string processing (zero native deps)
 * - Binary files (PDF, DOCX) are read as Buffer; text files as UTF-8 string
 * - Throws on unsupported extensions or parse failures
 *
 * Usage:
 *   const parser = new DocumentParserService()
 *   const doc = await parser.parseFile('/path/to/report.pdf')
 *   console.log(doc.title, doc.metadata.word_count)
 */
export class DocumentParserService {
  /**
   * Parse a document from its file path.
   *
   * Reads the file from disk and delegates to the appropriate format parser.
   * Throws if the file extension is unsupported or parsing fails.
   */
  async parseFile(filePath: string): Promise<ParsedDocument> {
    const format = detectFormat(filePath)
    logger.debug({ filePath, format }, '[document-parser] parsing file')

    const startMs = Date.now()
    let result: ParsedDocument

    if (format === 'pdf' || format === 'docx') {
      const { readFile } = await import('node:fs/promises')
      const buffer = await readFile(filePath)
      result = format === 'pdf'
        ? await parsePdf(buffer, filePath)
        : await parseDocx(buffer, filePath)
    } else {
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(filePath, 'utf-8')
      result = this.parseContent(content, filePath, format)
    }

    logger.info(
      {
        filePath,
        format,
        word_count: result.metadata.word_count,
        sections: result.sections.length,
        duration_ms: Date.now() - startMs,
      },
      '[document-parser] parse complete',
    )

    return result
  }

  /**
   * Parse a document from in-memory content (string or Buffer).
   *
   * Useful for testing and for callers that have already read the file.
   * Binary formats (PDF, DOCX) require a Buffer; text formats accept string.
   */
  parseContent(content: string, filePath: string, format: SupportedFormat): ParsedDocument
  parseContent(content: Buffer, filePath: string, format: 'pdf' | 'docx'): Promise<ParsedDocument>
  parseContent(
    content: string | Buffer,
    filePath: string,
    format: SupportedFormat,
  ): ParsedDocument | Promise<ParsedDocument> {
    switch (format) {
      case 'pdf':
        return parsePdf(content as Buffer, filePath)
      case 'docx':
        return parseDocx(content as Buffer, filePath)
      case 'md':
        return parseMarkdown(content as string, filePath)
      case 'txt':
        return parsePlainText(content as string, filePath)
      case 'html':
        return parseHtml(content as string, filePath)
    }
  }
}
