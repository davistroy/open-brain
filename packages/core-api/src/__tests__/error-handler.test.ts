import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { AppError, NotFoundError, ValidationError } from '@open-brain/shared'
import { errorHandler } from '../middleware/error-handler.js'

function createTestApp() {
  const app = new Hono()
  app.onError(errorHandler())
  return app
}

describe('error handler middleware', () => {
  it('maps AppError to correct status and code', async () => {
    const app = createTestApp()
    app.get('/test', () => { throw new AppError('test error', 422, 'TEST_CODE') })

    const res = await app.request('/test')
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toEqual({ error: 'test error', code: 'TEST_CODE' })
  })

  it('maps NotFoundError to 404', async () => {
    const app = createTestApp()
    app.get('/test', () => { throw new NotFoundError('thing not found') })

    const res = await app.request('/test')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })

  it('maps ValidationError to 400', async () => {
    const app = createTestApp()
    app.get('/test', () => { throw new ValidationError('invalid input') })

    const res = await app.request('/test')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('maps unknown errors to 500', async () => {
    const app = createTestApp()
    app.get('/test', () => { throw new Error('unexpected') })

    const res = await app.request('/test')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('INTERNAL_ERROR')
  })

  it('passes through successful responses', async () => {
    const app = createTestApp()
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })
})
