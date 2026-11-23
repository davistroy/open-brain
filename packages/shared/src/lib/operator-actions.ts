import { readFile } from 'node:fs/promises'

// ============================================================
// Operator-action register parser (SA7-10, PLT-020, RC7-02)
// ============================================================
//
// ONE tolerant parser for OPERATOR_ACTIONS.md. Status vocabulary (enforced
// by a test on the real register): OPEN, IN PROGRESS (open); DONE, BLOCKED,
// OBSOLETE, CLOSED (closed). `*`, the check mark and whitespace are ignored
// when matching, and detail after the keyword is free text. Any other status
// is a parse error, never silently "open".

export const OPERATOR_ACTIONS_URL = 'https://raw.githubusercontent.com/davistroy/open-brain/main/OPERATOR_ACTIONS.md'

export type OperatorActionState = 'open' | 'closed'

export interface OperatorAction {
  id: string
  action: string
  due: string
  /** UTC midnight of a plain YYYY-MM-DD Due cell, else null (never overdue). */
  dueDate: Date | null
  owner: string
  source: string
  /** Raw status cell. */
  status: string
  state: OperatorActionState
}

export interface OperatorActionParseError {
  id: string
  status: string
}

export interface ParsedOperatorActions {
  actions: OperatorAction[]
  parseErrors: OperatorActionParseError[]
}

export interface OperatorActionSummary {
  open: number
  overdue: number
  /** The (up to) 3 oldest overdue rows, oldest first. */
  oldest: OperatorAction[]
  parseErrors: OperatorActionParseError[]
}

const CLOSED_RE = /^(DONE|BLOCKED|OBSOLETE|CLOSED)/
const OPEN_RE = /^(OPEN|INPROGRESS)/

function classifyStatus(status: string): OperatorActionState | null {
  const norm = status.replace(/[*✅\s]/g, '').toUpperCase()
  if (CLOSED_RE.test(norm)) return 'closed'
  if (OPEN_RE.test(norm)) return 'open'
  return null
}

function parseDue(due: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const d = new Date(`${due}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Parse the `## Open Actions` table (stops at `## Completed Actions`). Never throws. */
export function parseOperatorActions(markdown: string): ParsedOperatorActions {
  const actions: OperatorAction[] = []
  const parseErrors: OperatorActionParseError[] = []
  const openIdx = markdown.indexOf('## Open Actions')
  if (openIdx === -1) return { actions, parseErrors }
  const rest = markdown.slice(openIdx)
  const endIdx = rest.indexOf('## Completed Actions')
  const section = endIdx === -1 ? rest : rest.slice(0, endIdx)

  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 6) continue
    const [id, action, due, owner, source, status] = cells
    if (id === 'ID' || /^-+$/.test(id)) continue
    const state = classifyStatus(status)
    if (state === null) {
      parseErrors.push({ id, status: status.slice(0, 60) })
      continue
    }
    actions.push({ id, action, due, dueDate: parseDue(due), owner, source, status, state })
  }
  return { actions, parseErrors }
}

/** A row is overdue when its due DATE is before today's UTC date. */
export function summarizeOperatorActions(parsed: ParsedOperatorActions, now: Date): OperatorActionSummary {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const open = parsed.actions.filter((a) => a.state === 'open')
  const overdue = open
    .filter((a) => a.dueDate !== null && a.dueDate.getTime() < todayUtc)
    .sort((a, b) => (a.dueDate as Date).getTime() - (b.dueDate as Date).getTime())
  return { open: open.length, overdue: overdue.length, oldest: overdue.slice(0, 3), parseErrors: parsed.parseErrors }
}

export interface LoadOperatorActionsOpts {
  /** Default OPERATOR_ACTIONS_URL. */
  url?: string
  /** Mounted copy read when the fetch fails. */
  fallbackPath: string
  timeoutMs?: number
  /** Test seam. */
  fetchFn?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>
}

/** Register text from the repo (10 s timeout), else from the mounted file. Throws when both fail. */
export async function loadOperatorActions(opts: LoadOperatorActionsOpts): Promise<string> {
  const fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i))
  try {
    const res = await fetchFn(opts.url ?? OPERATOR_ACTIONS_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
    if (res.ok) return await res.text()
  } catch {
    // fall through to the mounted file
  }
  return readFile(opts.fallbackPath, 'utf8')
}
