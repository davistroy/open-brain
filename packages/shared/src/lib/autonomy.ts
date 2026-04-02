/**
 * Autonomy level types and helpers.
 * All proactive features check autonomy level before taking action.
 */

export type AutonomyLevel = 'observe' | 'assist' | 'advise' | 'partner'

export const AUTONOMY_LEVELS: AutonomyLevel[] = ['observe', 'assist', 'advise', 'partner']

export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  observe: 'Notifications only — no autonomous actions',
  assist: 'Draft + notify — human relays responses',
  advise: 'Act + report — posts with clear bot attribution',
  partner: 'Autonomous within guardrails',
}

export const DEFAULT_AUTONOMY: AutonomyLevel = 'observe'

/**
 * Check if the current autonomy level meets or exceeds the required level.
 * Uses ordinal comparison based on AUTONOMY_LEVELS array order.
 */
export function meetsAutonomyLevel(current: AutonomyLevel, required: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(current) >= AUTONOMY_LEVELS.indexOf(required)
}
