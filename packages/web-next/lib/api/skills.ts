/**
 * Skills API — trigger and list skills.
 * Covers both the write side (skillsApi: POST trigger) and the read/schedule
 * side (skillsListApi: GET list, PATCH schedule).
 */

import { request } from './core'

// ---------------------------------------------------------------------------
// skillsApi — generic skill trigger via POST /api/v1/skills/:name/trigger
// ---------------------------------------------------------------------------

export interface SkillTriggerResponse {
  skill: string
  job_id: string
  status: string
  message: string
}

export const skillsApi = {
  /**
   * POST /api/v1/skills/:name/trigger — manually trigger any skill by name.
   * Returns 202 with { skill, job_id, status: 'queued', message }.
   * Optional params are forwarded as the request body (skill overrides / input).
   */
  trigger: (
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<SkillTriggerResponse> => {
    return request<SkillTriggerResponse>(
      `/skills/${encodeURIComponent(name)}/trigger`,
      { method: 'POST', body: JSON.stringify(params) },
    )
  },
}

// ---------------------------------------------------------------------------
// skillsListApi — list skills via GET /api/v1/skills (read side only)
// The write side (trigger) already exists in skillsApi above.
// ---------------------------------------------------------------------------

/** One skill record as returned by GET /api/v1/skills */
export interface SkillRecord {
  name: string
  schedule: string | null
  description: string | null
  last_run_at: string | null
  last_duration_ms: number | null
  last_output_summary: string | null
  last_input_summary: string | null
}

export const skillsListApi = {
  /** GET /api/v1/skills — full list of configured skills + last-run metadata */
  list: (): Promise<{ skills: SkillRecord[] }> => {
    return request<{ skills: SkillRecord[] }>('/skills')
  },

  /**
   * PATCH /api/v1/skills/:name — update a skill's cron schedule.
   * Body: { schedule: string }. Returns { name, schedule, updated_at }.
   */
  updateSchedule: (
    name: string,
    schedule: string,
  ): Promise<{ name: string; schedule: string; updated_at: string }> => {
    return request<{ name: string; schedule: string; updated_at: string }>(
      `/skills/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify({ schedule }) },
    )
  },
}
