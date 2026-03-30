/**
 * Error thrown when an HTTP response has a non-2xx status code.
 * Includes status code and response body for caller-side branching
 * (e.g., 4xx vs 5xx for retry decisions).
 */
export class HttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, context?: string) {
    super(`${context ? context + ': ' : ''}HTTP ${status}: ${body}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/** Read the text body from a failed response without throwing. */
export async function readErrorBody(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

/**
 * Assert that a fetch response is ok (2xx). Throws HttpError with
 * status, body, and optional context string if not.
 */
export async function assertOk(res: Response, context?: string): Promise<void> {
  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new HttpError(res.status, body, context)
  }
}
