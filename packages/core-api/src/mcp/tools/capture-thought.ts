import { z } from 'zod'
import type { CaptureService } from '../../services/capture.js'
import type { ConfigService } from '@open-brain/shared'
import type { CaptureType } from '@open-brain/shared'

export const captureThoughtSchema = z.object({
  content: z.string().min(1).describe('The thought, idea, decision, or note to capture'),
  tags: z.array(z.string()).optional().describe('Optional tags to apply'),
  brain_view: z.string().optional().describe('Brain view to assign (career, personal, technical, work-internal, client). Defaults to technical.'),
  capture_type: z.string().optional().describe('Capture type: decision, idea, observation, task, win, blocker, question, reflection. Defaults to observation.'),
})

export type CaptureThoughtInput = z.infer<typeof captureThoughtSchema>

export async function captureThoughtTool(
  input: CaptureThoughtInput,
  captureService: CaptureService,
  configService: ConfigService,
): Promise<string> {
  const validViews = configService.getBrainViews()
  const brainView = input.brain_view && validViews.includes(input.brain_view)
    ? input.brain_view
    : (validViews[0] ?? 'technical')

  const capture = await captureService.create({
    content: input.content,
    capture_type: (input.capture_type as CaptureType | undefined) ?? 'observation',
    brain_view: brainView,
    source: 'mcp',
    metadata: {
      tags: input.tags ?? [],
    },
  })

  const lines = [
    `Captured successfully.`,
    ``,
    `ID:     ${capture.id}`,
    `Type:   ${capture.capture_type}`,
    `View:   ${capture.brain_view}`,
    `Status: ${capture.pipeline_status}`,
  ]

  if (input.tags && input.tags.length > 0) {
    lines.push(`Tags:   ${input.tags.join(', ')}`)
  }

  lines.push(``, `The capture is now in the pipeline for embedding and metadata extraction.`)

  return lines.join('\n')
}
