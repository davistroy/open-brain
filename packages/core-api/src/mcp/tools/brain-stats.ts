import { z } from 'zod'
import type { CaptureService } from '../../services/capture.js'

export const brainStatsSchema = z.object({
  period: z.enum(['week', 'month', 'all']).default('all').describe('Time period for stats'),
})

export type BrainStatsInput = z.infer<typeof brainStatsSchema>

export async function brainStatsTool(input: BrainStatsInput, captureService: CaptureService): Promise<string> {
  const stats = await captureService.getStats()

  const lines: string[] = [
    `Brain Statistics (period: ${input.period})`,
    '='.repeat(40),
    '',
    `Total captures: ${stats.total_captures}`,
    '',
    'By source:',
    ...Object.entries(stats.by_source)
      .sort(([, a], [, b]) => b - a)
      .map(([source, count]) => `  ${source}: ${count}`),
    '',
    'By capture type:',
    ...Object.entries(stats.by_type)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `  ${type}: ${count}`),
    '',
    'By brain view:',
    ...Object.entries(stats.by_view)
      .sort(([, a], [, b]) => b - a)
      .map(([view, count]) => `  ${view}: ${count}`),
    '',
    'Pipeline health:',
    `  complete:   ${stats.pipeline_health.complete}`,
    `  pending:    ${stats.pipeline_health.pending}`,
    `  processing: ${stats.pipeline_health.processing}`,
    `  failed:     ${stats.pipeline_health.failed}`,
  ]

  if (stats.total_entities > 0) {
    lines.push('')
    lines.push(`Total entities: ${stats.total_entities}`)
  }

  return lines.join('\n')
}
