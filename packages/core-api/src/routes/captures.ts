import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { CaptureService } from '../services/capture.js'
import { ConfigService, ValidationError } from '@open-brain/shared'
import {
  createCaptureSchema,
  updateCaptureSchema,
  listCapturesSchema,
} from '../schemas/capture.js'

export function registerCaptureRoutes(
  app: Hono,
  captureService: CaptureService,
  configService: ConfigService,
): void {
  // POST /api/v1/captures — create a new capture
  app.post('/api/v1/captures', zValidator('json', createCaptureSchema), async (c) => {
    const body = c.req.valid('json')

    // Validate brain_view against configured views
    const validViews = configService.getBrainViews()
    if (!validViews.includes(body.brain_view)) {
      throw new ValidationError(`Invalid brain_view: ${body.brain_view}. Valid values: ${validViews.join(', ')}`)
    }

    const capture = await captureService.create({
      content: body.content,
      capture_type: body.capture_type,
      brain_view: body.brain_view,
      source: body.source ?? 'api',
      metadata: body.metadata,
    })

    return c.json({
      id: capture.id,
      pipeline_status: capture.pipeline_status,
      created_at: capture.created_at,
    }, 201)
  })

  // GET /api/v1/captures — list captures with filters and pagination
  app.get('/api/v1/captures', zValidator('query', listCapturesSchema), async (c) => {
    const query = c.req.valid('query')

    const filter = {
      brain_view: query.brain_view,
      capture_type: query.capture_type as any,
      source: query.source as any,
      tags: query.tags,
      date_from: query.date_from ? new Date(query.date_from) : undefined,
      date_to: query.date_to ? new Date(query.date_to) : undefined,
      pipeline_status: query.pipeline_status,
    }

    const { items, total } = await captureService.list(filter, query.limit, query.offset)

    return c.json({
      items,
      total,
      limit: query.limit,
      offset: query.offset,
    })
  })

  // GET /api/v1/captures/:id — get capture by id
  app.get('/api/v1/captures/:id', async (c) => {
    const id = c.req.param('id')
    const capture = await captureService.getById(id)
    return c.json(capture)
  })

  // PATCH /api/v1/captures/:id — update tags/brain_view/metadata
  app.patch('/api/v1/captures/:id', zValidator('json', updateCaptureSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    // Validate brain_view if provided
    if (body.brain_view !== undefined) {
      const validViews = configService.getBrainViews()
      if (!validViews.includes(body.brain_view)) {
        throw new ValidationError(`Invalid brain_view: ${body.brain_view}. Valid values: ${validViews.join(', ')}`)
      }
    }

    const updated = await captureService.update(id, {
      tags: body.tags,
      brain_view: body.brain_view,
      metadata_overrides: body.metadata_overrides,
    })

    return c.json(updated)
  })

  // DELETE /api/v1/captures/:id — soft delete
  app.delete('/api/v1/captures/:id', async (c) => {
    const id = c.req.param('id')
    await captureService.softDelete(id)
    return new Response(null, { status: 204 })
  })
}
