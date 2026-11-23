import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushoverService } from '../services/pushover.js'
import type { SlackMessenger } from '@open-brain/shared'
import { alertStateKey, type AlertState } from '../lib/alert-state.js'
import { buildOpsDigest, OpsDigestSkill, DIGEST_INFO_SOURCES, PUSH_CAP } from '../skills/ops-digest.js'

const NOW = new Date('2026-11-23T12:30:00Z')
const HOUR = 3_600_000

function alertRow(key: string, hoursOpen: number, over: Partial<AlertState> = {}) {
  const since = new Date(NOW.getTime() - hoursOpen * HOUR).toISOString()
  const state: AlertState = {
    status: 'bad', since, last_notified_at: since, level: 0, receipt: null, acked_at: null, ...over,
  }
  return { key: alertStateKey(key), value: state }
}

/** db.execute mock: alert-state rows + skills_log rows (rendered through the real dialect). */
function makeDb(
  alerts: ReturnType<typeof alertRow>[],
  reports: Array<{ skill_name: string; output_summary: string }>,
  opts: { failAlertRead?: boolean } = {},
) {
  const dialect = new PgDialect()
  const queries: Array<{ text: string; params: unknown[] }> = []
  const execute = vi.fn().mockImplementation(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    queries.push({ text, params })
    if (text.includes('FROM app_settings')) {
      if (opts.failAlertRead) throw new Error('app_settings read failed')
      return { rows: alerts }
    }
    if (text.includes('FROM skills_log')) return { rows: reports }
    if (text.includes('INSERT INTO')) return { rows: [] }
    throw new Error(`unexpected SQL: ${text}`)
  })
  const returning = vi.fn().mockResolvedValue([{ id: 'log-1' }])
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) })
  return { db: { execute, insert } as never, queries }
}

const FIVE_REPORTS = ['drift-monitor', 'wiki-lint', 'email-classify', 'storage-audit', 'secret-rotation'].map((n) => ({
  skill_name: n,
  output_summary: `${n} summary line`,
}))

describe('buildOpsDigest', () => {
  it('is empty with no alerts and no reports', async () => {
    const { db } = makeDb([], [])
    const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    expect(d.openAlerts).toEqual([])
    expect(d.infoLines).toEqual([])
    expect(d.isEmpty).toBe(true)
  })

  it('lists the open alerts with ages before any report line', async () => {
    const { db } = makeDb([alertRow('backup-stale', 50, { level: 1 }), alertRow('jetson-down', 3)], FIVE_REPORTS)
    const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    expect(d.isEmpty).toBe(false)
    expect(d.openAlerts.map((a) => a.key)).toEqual(['backup-stale', 'jetson-down']) // oldest first
    expect(d.infoLines).toHaveLength(5)
    const lines = d.pushText.split('\n')
    const firstAlert = lines.findIndex((l) => l.includes('backup-stale'))
    const secondAlert = lines.findIndex((l) => l.includes('jetson-down'))
    const firstReport = lines.findIndex((l) => l.includes('drift-monitor'))
    expect(firstAlert).toBeGreaterThanOrEqual(0)
    expect(secondAlert).toBeGreaterThan(firstAlert)
    expect(firstReport).toBeGreaterThan(secondAlert)
    expect(d.pushText).toMatch(/backup-stale.*2 d/)
    expect(d.pushText).toMatch(/jetson-down.*3 h/)
  })

  it('reads reports only for the digest sources, from the last 24 hours', async () => {
    const { db, queries } = makeDb([], FIVE_REPORTS)
    await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    const q = queries.find((x) => x.text.includes('FROM skills_log'))!
    for (const s of DIGEST_INFO_SOURCES) expect(q.params).toContain(s)
    expect(q.params).toContain(new Date(NOW.getTime() - 24 * HOUR).toISOString())
  })

  it('keeps every alert line in pushText when the text exceeds 1,024 characters; fullText carries all', async () => {
    const alerts = Array.from({ length: 6 }, (_, i) => alertRow(`alert-${i}`, 5 + i))
    const reports = DIGEST_INFO_SOURCES.map((n) => ({ skill_name: n, output_summary: 'x'.repeat(400) }))
    const { db } = makeDb(alerts, reports)
    const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    expect(d.fullText.length).toBeGreaterThan(PUSH_CAP)
    expect(d.pushText.length).toBeLessThanOrEqual(PUSH_CAP)
    for (let i = 0; i < 6; i++) expect(d.pushText).toContain(`alert-${i}`)
    for (const n of DIGEST_INFO_SOURCES) expect(d.fullText).toContain(n)
    expect(d.pushText).toMatch(/more in Slack/)
  })

  it('F1: lists per-queue alert keys readably', async () => {
    const { db } = makeDb(
      [alertRow('queue-failed:ingest-root', 3), alertRow('queue-backlog:capture-pipeline', 50), alertRow('queue-stalled:embed-capture', 1)],
      [],
    )
    const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    const lines = d.pushText.split('\n')
    expect(lines).toContain('- capture-pipeline queue backlog: open 2 d')
    expect(lines).toContain('- ingest-root queue failures: open 3 h')
    expect(lines).toContain('- embed-capture stalled jobs: open 1 h')
    expect(d.openAlerts.map((a) => a.key)).toContain('queue-failed:ingest-root') // raw key kept
  })

  it('F2: ALERT_STATE_ENABLED=false shows no alert block and does not read alert_state rows', async () => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    try {
      const { db, queries } = makeDb([alertRow('backup-stale', 30 * 24)], FIVE_REPORTS.slice(0, 1))
      const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
      expect(d.openAlerts).toEqual([])
      expect(d.fullText).not.toContain('backup-stale')
      expect(d.fullText).not.toMatch(/Open alerts/)
      expect(d.fullText).toContain('drift-monitor')
      expect(queries.some((q) => q.text.includes('FROM app_settings'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('F4: an alert-state read failure adds one "alert state unavailable" line and keeps the report lines', async () => {
    const { db } = makeDb([], FIVE_REPORTS, { failAlertRead: true })
    const d = await buildOpsDigest(db, NOW, { backupManifestPath: '/nonexistent/manifest.json' })
    expect(d.alertStateUnavailable).toBe(true)
    expect(d.isEmpty).toBe(false)
    expect(d.infoLines).toHaveLength(5)
    const lines = d.pushText.split('\n')
    expect(lines[0]).toBe('Alert state unavailable')
    expect(d.pushText).toContain('drift-monitor')
    expect(d.fullText).toContain('Alert state unavailable')
  })

  it('reports backup age from the manifest mtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-digest-'))
    try {
      const p = join(dir, 'manifest.json')
      writeFileSync(p, '{}')
      const t = new Date(NOW.getTime() - 5 * HOUR)
      utimesSync(p, t, t)
      const { db } = makeDb([], FIVE_REPORTS.slice(0, 1))
      const d = await buildOpsDigest(db, NOW, { backupManifestPath: p })
      expect(d.backupAgeSeconds).toBe(5 * 3600)
      expect(d.pushText).toMatch(/Backup: 5 h old/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OpsDigestSkill', () => {
  let pushover: PushoverService
  let send: MockInstance<PushoverService['send']>
  const slackSend = vi.fn().mockResolvedValue(true)
  const slack = { isConfigured: true, sendMessage: slackSend } as unknown as SlackMessenger

  beforeEach(() => {
    pushover = new PushoverService('fake-token', 'fake-user')
    send = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)
    slackSend.mockReset().mockResolvedValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  const mk = (db: never) =>
    new OpsDigestSkill({
      db, pushover, slack, slackChannelId: 'D-TEST', backupManifestPath: '/nonexistent/manifest.json',
    })

  it('sends no Pushover and no Slack message when nothing is open or reported', async () => {
    const { db } = makeDb([], [])
    const r = await mk(db).execute({ now: NOW })
    expect(send).not.toHaveBeenCalled()
    expect(slackSend).not.toHaveBeenCalled()
    expect(r.sent).toBe(false)
    expect(r.slackSent).toBe(false)
  })

  it('sends one priority-0 push and the full text to Slack', async () => {
    const { db } = makeDb([alertRow('backup-stale', 30), alertRow('jetson-down', 2)], FIVE_REPORTS)
    const r = await mk(db).execute({ now: NOW })
    expect(send).toHaveBeenCalledTimes(1)
    const arg = send.mock.calls[0][0]
    expect(arg.priority).toBe(0)
    expect(arg.message.indexOf('backup-stale')).toBeLessThan(arg.message.indexOf('drift-monitor'))
    expect(slackSend).toHaveBeenCalledWith({ channel: 'D-TEST', text: expect.stringContaining('wiki-lint') })
    expect(r.sent).toBe(true)
    expect(r.slackSent).toBe(true)
    expect(r.openAlerts).toBe(2)
    expect(r.infoLines).toBe(5)
  })

  it('F4: still sends the report lines when the alert-state read throws', async () => {
    const { db } = makeDb([], FIVE_REPORTS, { failAlertRead: true })
    const r = await mk(db).execute({ now: NOW })
    expect(send).toHaveBeenCalledTimes(1)
    const msg = send.mock.calls[0][0].message
    expect(msg).toContain('Alert state unavailable')
    expect(msg).toContain('drift-monitor')
    expect(slackSend).toHaveBeenCalledWith({ channel: 'D-TEST', text: expect.stringContaining('wiki-lint') })
    expect(r.sent).toBe(true)
    expect(r.infoLines).toBe(5)
  })

  it('declares no minimum_autonomy', () => {
    expect((OpsDigestSkill as unknown as { minimum_autonomy?: string }).minimum_autonomy).toBeUndefined()
  })

  it('skips Slack when no channel is configured and survives a Pushover failure', async () => {
    send.mockRejectedValue(new Error('boom'))
    const { db } = makeDb([alertRow('x', 1)], [])
    const skill = new OpsDigestSkill({ db, pushover, slack, slackChannelId: '', backupManifestPath: '/nonexistent/m.json' })
    const r = await skill.execute({ now: NOW })
    expect(r.sent).toBe(false)
    expect(slackSend).not.toHaveBeenCalled()
  })
})
