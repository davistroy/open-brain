/**
 * Integration tests for POST /api/v1/voice-captures
 *
 * The route is a thin HTTP proxy: it parses multipart FormData, validates the
 * `file` field, rebuilds a FormData for the upstream voice-capture service, and
 * forwards the response body + status verbatim.
 *
 * All upstream calls are intercepted via vi.spyOn(global, 'fetch') — no real
 * network traffic is required, and no database or Redis is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createApp } from '../../app.js'

// ---------------------------------------------------------------------------
// Test app — no service deps needed; voice-captures route is unconditional
// ---------------------------------------------------------------------------

const app = createApp({})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a multipart Request targeting the voice-captures proxy endpoint.
 *
 * Do NOT pass Content-Type manually — the runtime sets it automatically with
 * the correct boundary when FormData is used as the body.
 */
function buildMultipartRequest(fields: Record<string, string | Blob> = {}): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Blob) {
      form.append(key, value, 'test.m4a')
    } else {
      form.append(key, value)
    }
  }
  return new Request('http://localhost/api/v1/voice-captures', {
    method: 'POST',
    // Include bypass header so the strict-tier rate limiter does not 429 us.
    headers: { 'X-Open-Brain-Caller': 'integration-test' },
    body: form,
  })
}

/** A minimal audio blob that stands in for a real voice recording. */
const fakeAudioBlob = new Blob(['fake audio data'], { type: 'audio/mp4' })

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/v1/voice-captures', () => {
  // Typed as MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>
  // to satisfy lib.dom.d.ts — avoids the "unknown[] vs [string | Request | URL, ...]"
  // variance error described in CLAUDE.md test patterns.
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch') as MockInstance<
      Parameters<typeof fetch>,
      ReturnType<typeof fetch>
    >
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // 1. Success path — upstream returns 201
  // -------------------------------------------------------------------------

  it('returns 201 and forwards the upstream response body on success', async () => {
    const upstreamBody = {
      ok: true,
      capture: { id: 'test-id' },
      transcription: { text: 'hello' },
    }

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamBody), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const req = buildMultipartRequest({ file: fakeAudioBlob })
    const res = await app.fetch(req)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual(upstreamBody)
  })

  // -------------------------------------------------------------------------
  // 2. Upstream error — 400 surfaces verbatim
  // -------------------------------------------------------------------------

  it('forwards a 400 status and body when the upstream rejects the audio', async () => {
    const upstreamError = { error: 'bad audio format' }

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamError), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const req = buildMultipartRequest({ file: fakeAudioBlob })
    const res = await app.fetch(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual(upstreamError)
  })

  // -------------------------------------------------------------------------
  // 3. Missing file field — 400 ValidationError
  // -------------------------------------------------------------------------

  it('returns 400 with VALIDATION_ERROR when the file field is absent', async () => {
    // Send a multipart request with only a text field — no `file` entry.
    const req = buildMultipartRequest({ note: 'audio missing' })
    const res = await app.fetch(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toMatch(/file/i)

    // The upstream should never be called when validation fails.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 4. Upstream unreachable — 502 BAD_GATEWAY
  // -------------------------------------------------------------------------

  it('returns 502 with BAD_GATEWAY when the upstream service is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const req = buildMultipartRequest({ file: fakeAudioBlob })
    const res = await app.fetch(req)

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('BAD_GATEWAY')
    expect(typeof body.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // 5. Optional fields are forwarded to the upstream
  // -------------------------------------------------------------------------

  it('includes optional fields (brain_view, device, latitude) in the upstream FormData', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const req = buildMultipartRequest({
      file: fakeAudioBlob,
      brain_view: 'technical',
      device: 'mobile-web',
      latitude: '35.5',
    })

    const res = await app.fetch(req)
    expect(res.status).toBe(201)

    // Verify fetch was called once and inspect the forwarded FormData.
    expect(fetchSpy).toHaveBeenCalledOnce()

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const forwarded = init.body as FormData

    // The forwarded body must be a FormData instance.
    expect(forwarded).toBeInstanceOf(FormData)

    // All fields sent by the client must be present upstream.
    expect(forwarded.get('brain_view')).toBe('technical')
    expect(forwarded.get('device')).toBe('mobile-web')
    expect(forwarded.get('latitude')).toBe('35.5')

    // The file entry must be present (as a File or Blob).
    const forwardedFile = forwarded.get('file')
    expect(forwardedFile).toBeTruthy()
    expect(forwardedFile).toBeInstanceOf(Blob)
  })
})
