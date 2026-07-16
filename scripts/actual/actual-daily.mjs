#!/usr/bin/env node
/**
 * actual-ingest sidecar entrypoint (issue #311 / spec 2026-07-15).
 *
 * Thin composition root: wires real @actual-app/api, fetch, fs, and env into
 * runDaily(). All money-correctness logic and its tests live in ./lib. Driven
 * by host cron `0 6 * * *` (6am ET natively — the homeserver TZ is
 * America/New_York, sidestepping #295). Runs once, exits non-zero on failure so
 * the cron log retains it.
 *
 * Secrets arrive via env_file (.env.secrets) — never baked into the image.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as actual from '@actual-app/api'
import { runDaily } from './lib/run-daily.mjs'

const env = process.env
const SERVER_URL = requireEnv('ACTUAL_SERVER_URL')
const PASSWORD = requireEnv('ACTUAL_PASSWORD')
const SYNC_ID = requireEnv('ACTUAL_SYNC_ID')
const DATA_DIR = env.ACTUAL_DATA_DIR ?? '/data/actual'
const STATE_PATH = env.ACTUAL_STATE_PATH ?? '/data/state.json'
const RULES_PATH = env.ACTUAL_RULES_PATH ?? '/app/config/payee-rules.yaml'
const CORE_API_URL = env.CORE_API_URL ?? 'http://core-api:3000'
const LOOKBACK_DAYS = Number(env.ACTUAL_LOOKBACK_DAYS ?? '7')
const THRESHOLD_MINOR = Math.round(Number(env.ACTUAL_NOTABLE_USD ?? '500') * 100)
const PCT = Number(env.ACTUAL_BALANCE_PCT ?? '0.05')
const CATEGORY_GROUP = env.ACTUAL_CATEGORY_GROUP // optional

const logger = {
  info: (m) => console.log(JSON.stringify({ level: 'info', svc: 'actual-ingest', msg: m })),
  warn: (m) => console.warn(JSON.stringify({ level: 'warn', svc: 'actual-ingest', msg: m })),
  error: (m) => console.error(JSON.stringify({ level: 'error', svc: 'actual-ingest', msg: m })),
}

function requireEnv(name) {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    console.error(JSON.stringify({ level: 'error', svc: 'actual-ingest', msg: `missing required env ${name}` }))
    process.exit(1)
  }
  return v
}

/** Date helpers pinned to America/New_York so the stamp matches the 6am-ET run. */
function easternDate(offsetDays = 0) {
  const now = new Date(Date.now() - offsetDays * 86_400_000)
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now)
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function writeState(map) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(map, null, 2))
}

async function postCapture(capture) {
  const res = await fetch(`${CORE_API_URL}/api/v1/captures`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Open-Brain-Caller': 'actual-pipeline',
    },
    body: JSON.stringify(capture),
    signal: AbortSignal.timeout(30_000),
  })
  return { ok: res.ok, status: res.status }
}

async function sendPushover(title, message) {
  const token = env.PUSHOVER_APP_TOKEN
  const user = env.PUSHOVER_USER_KEY
  if (!token || !user) {
    logger.warn('Pushover not configured — skipping notification')
    return
  }
  const body = new URLSearchParams({ token, user, title, message, priority: '0' })
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Pushover API ${res.status}`)
}

/** downloadBudget can hit a transient UND_ERR_SOCKET (§9) — retry a few times. */
async function downloadWithRetry(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await actual.downloadBudget(SYNC_ID, { password: PASSWORD })
      return
    } catch (err) {
      const transient = /UND_ERR_SOCKET|ECONNRESET|socket/i.test(`${err.code ?? ''} ${err.message ?? ''}`)
      if (!transient || i === attempts) throw err
      logger.warn(`downloadBudget transient failure (attempt ${i}/${attempts}): ${err.message} — retrying`)
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

async function main() {
  let rulesText
  try {
    rulesText = readFileSync(RULES_PATH, 'utf8')
  } catch (err) {
    // §4.3 — a missing rules file is a hard abort, not a silent no-op.
    throw new Error(`cannot read payee rules at ${RULES_PATH}: ${err.message}`)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  await actual.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD })
  try {
    await downloadWithRetry()
    const result = await runDaily({
      api: actual,
      rulesText,
      readState,
      writeState,
      postCapture,
      sendPushover,
      config: {
        date: easternDate(0),
        startDate: easternDate(LOOKBACK_DAYS),
        endDate: easternDate(0),
        thresholdMinor: THRESHOLD_MINOR,
        pct: PCT,
        categoryGroupName: CATEGORY_GROUP,
      },
      logger,
    })
    logger.info(
      `done: categorized ${result.categorized.length} group(s), ` +
        `${result.unmatchedPayees.length} unmatched, ` +
        `${result.excluded.transfer + result.excluded.investment} excluded, sync_failed=${result.syncFailed}`,
    )
  } finally {
    await actual.shutdown()
  }
}

main().catch((err) => {
  logger.error(`run failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
