import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  Layers,
  Clock,
  DollarSign,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/utils'
import { systemHealthApi } from '@/lib/api'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { SystemHealthData } from '@/lib/types'

// ─── Thresholds ──────────────────────────────────────────────────────────────

const QUEUE_WARN = 50
const QUEUE_CRIT = 200
const SPEND_WARN = 7
const POLL_INTERVAL_MS = 30_000
const SSE_RETRY_MS = 60_000

type StatusLevel = 'green' | 'yellow' | 'red' | 'gray'

function queueLevel(total: number): StatusLevel {
  if (total >= QUEUE_CRIT) return 'red'
  if (total >= QUEUE_WARN) return 'yellow'
  return 'green'
}

function spendLevel(spent: number, budget: number): StatusLevel {
  if (spent >= budget) return 'red'
  if (spent >= SPEND_WARN) return 'yellow'
  return 'green'
}

function overallLevel(data: SystemHealthData | null): StatusLevel {
  if (!data) return 'gray'
  if (data.status === 'unhealthy') return 'red'
  if (data.status === 'degraded') return 'yellow'

  // Check component-level thresholds
  const qTotal = data.queues.total_waiting + data.queues.total_active
  const qLvl = queueLevel(qTotal)
  const sLvl = spendLevel(data.llm_spend?.month_total_usd ?? 0, data.llm_spend?.budget_usd ?? 35)

  if (qLvl === 'red' || sLvl === 'red') return 'red'
  if (qLvl === 'yellow' || sLvl === 'yellow') return 'yellow'
  return 'green'
}

// ─── Status Dot ──────────────────────────────────────────────────────────────

const DOT_COLORS: Record<StatusLevel, string> = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
  gray: 'bg-gray-400',
}

const DOT_PULSE: Record<StatusLevel, string> = {
  green: '',
  yellow: 'animate-pulse',
  red: 'animate-pulse',
  gray: '',
}

function StatusDot({ level, className }: { level: StatusLevel; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full shrink-0',
        DOT_COLORS[level],
        DOT_PULSE[level],
        className,
      )}
    />
  )
}

// ─── Indicator Items ─────────────────────────────────────────────────────────

function IndicatorButton({
  children,
  onClick,
  tooltip,
  level = 'green',
}: {
  children: React.ReactNode
  onClick: () => void
  tooltip: string
  level?: StatusLevel
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            level === 'red'
              ? 'text-red-600 dark:text-red-400'
              : level === 'yellow'
              ? 'text-yellow-600 dark:text-yellow-400'
              : 'text-muted-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

// ─── StatusStrip Component ───────────────────────────────────────────────────

export default function StatusStrip() {
  const navigate = useNavigate()
  const [data, setData] = useState<SystemHealthData | null>(null)
  const [expanded, setExpanded] = useState(false)
  const sseRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sseRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Try to connect to SSE first, fall back to polling
  const connectSSE = useCallback(() => {
    try {
      const es = new EventSource('/api/v1/system/health/stream')
      sseRef.current = es

      // SSE returns SystemHealthSnapshot shape; map to SystemHealthData for the strip
      const mapSSE = (raw: Record<string, unknown>): SystemHealthData => {
        const spend = raw.monthly_spend as { total_usd?: number } | undefined
        const queues = Array.isArray(raw.queues) ? raw.queues as { waiting: number; active: number; failed: number; name: string }[] : []
        const byQueue: Record<string, { waiting: number; active: number; failed: number }> = {}
        let tw = 0, ta = 0, tf = 0
        for (const q of queues) { tw += q.waiting; ta += q.active; tf += q.failed; byQueue[q.name] = { waiting: q.waiting, active: q.active, failed: q.failed } }
        const skills = Array.isArray(raw.skill_last_runs) ? raw.skill_last_runs as { skill_name: string; last_run_at: string; duration_ms: number }[] : []
        const lastSkill = skills.length > 0 ? skills.reduce((a, b) => a.last_run_at > b.last_run_at ? a : b) : null
        return {
          status: (raw.status as SystemHealthData['status']) ?? 'unhealthy',
          timestamp: (raw.timestamp as string) ?? new Date().toISOString(),
          queues: { total_waiting: tw, total_active: ta, total_failed: tf, by_queue: byQueue },
          last_skill_run: lastSkill ? { name: lastSkill.skill_name, status: 'success', completed_at: lastSkill.last_run_at } : null,
          llm_spend: { month_total_usd: spend?.total_usd ?? 0, budget_usd: 35 },
          services: (raw.services as SystemHealthData['services']) ?? { postgres: { status: 'unknown' }, redis: { status: 'unknown' }, llm: { status: 'unknown' } },
        }
      }

      es.addEventListener('system_health', (evt: MessageEvent) => {
        try {
          const raw = JSON.parse(evt.data)
          setData(raw.llm_spend ? raw as SystemHealthData : mapSSE(raw))
        } catch { /* ignore parse errors */ }
      })

      // Also handle generic message events (SSE event type = "system_health")
      es.onmessage = (evt) => {
        try {
          const raw = JSON.parse(evt.data)
          setData(raw.llm_spend ? raw as SystemHealthData : mapSSE(raw))
        } catch { /* ignore */ }
      }

      es.onerror = () => {
        // SSE failed (endpoint doesn't exist yet or connection lost)
        // Close and fall back to polling
        es.close()
        sseRef.current = null
        startPolling()
        // Retry SSE after a longer interval
        sseRetryRef.current = setTimeout(connectSSE, SSE_RETRY_MS)
      }

      // If SSE works, stop polling
      es.onopen = () => {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        if (sseRetryRef.current) {
          clearTimeout(sseRetryRef.current)
          sseRetryRef.current = null
        }
      }
    } catch {
      // EventSource constructor failed — fall back to polling
      startPolling()
    }
  }, [])

  const fetchHealth = useCallback(async () => {
    try {
      // Try the new system health endpoint first
      const snapshot = await systemHealthApi.snapshot()
      setData(snapshot)
    } catch {
      // Fall back to legacy endpoints
      try {
        const fallback = await systemHealthApi.fallbackSnapshot()
        setData(fallback)
      } catch {
        // Both failed — show disconnected state
        setData(null)
      }
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollRef.current) return // already polling
    fetchHealth() // immediate first fetch
    pollRef.current = setInterval(fetchHealth, POLL_INTERVAL_MS)
  }, [fetchHealth])

  useEffect(() => {
    // Initial data fetch
    fetchHealth()
    // Try SSE, will fall back to polling if unavailable
    connectSSE()

    return () => {
      if (sseRef.current) {
        sseRef.current.close()
        sseRef.current = null
      }
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (sseRetryRef.current) {
        clearTimeout(sseRetryRef.current)
        sseRetryRef.current = null
      }
    }
  }, [fetchHealth, connectSSE])

  const level = overallLevel(data)
  const goSettings = () => navigate('/settings')

  // ─── Computed display values ─────────────────────────────────────────────

  const queueTotal = data
    ? data.queues.total_waiting + data.queues.total_active
    : 0
  const queueFailed = data?.queues.total_failed ?? 0
  const qLevel = data ? queueLevel(queueTotal) : 'gray'

  const lastSkill = data?.last_skill_run
  const lastSkillText = lastSkill
    ? `${lastSkill.name} ${relativeTime(lastSkill.completed_at)}`
    : 'none'

  const spentUsd = data?.llm_spend?.month_total_usd ?? 0
  const budgetUsd = data?.llm_spend?.budget_usd ?? 35
  const sLevel = data ? spendLevel(spentUsd, budgetUsd) : 'gray'

  const queueTooltip = data
    ? `Queue: ${data.queues.total_waiting} waiting, ${data.queues.total_active} active, ${queueFailed} failed`
    : 'System health: connecting...'

  const skillTooltip = lastSkill
    ? `Last skill: ${lastSkill.name} (${lastSkill.status}) ${relativeTime(lastSkill.completed_at)}`
    : 'No recent skill runs'

  const spendTooltip = `LLM spend: $${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)} this month`

  // ─── Desktop strip ──────────────────────────────────────────────────────

  return (
    <TooltipProvider delayDuration={300}>
      {/* Desktop: full strip */}
      <div className="hidden md:flex items-center gap-1 border-b bg-card/50 px-4 py-1 text-xs">
        {/* Overall status dot */}
        <IndicatorButton onClick={goSettings} tooltip={data ? `System: ${data.status}` : 'Connecting...'} level={level}>
          <StatusDot level={level} />
          <span className="sr-only">System status</span>
        </IndicatorButton>

        <span className="text-border">|</span>

        {/* Queue depths */}
        <IndicatorButton onClick={goSettings} tooltip={queueTooltip} level={qLevel}>
          <Layers className="h-3 w-3" />
          <span>{queueTotal} queued</span>
          {queueFailed > 0 && (
            <span className="text-red-500 dark:text-red-400">({queueFailed} failed)</span>
          )}
        </IndicatorButton>

        <span className="text-border">|</span>

        {/* Last skill run */}
        <IndicatorButton onClick={goSettings} tooltip={skillTooltip}>
          <Clock className="h-3 w-3" />
          <span className="max-w-[200px] truncate">{lastSkillText}</span>
        </IndicatorButton>

        <span className="text-border">|</span>

        {/* LLM spend */}
        <IndicatorButton onClick={goSettings} tooltip={spendTooltip} level={sLevel}>
          <DollarSign className="h-3 w-3" />
          <span>${spentUsd.toFixed(2)} / ${budgetUsd}</span>
        </IndicatorButton>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Connection indicator */}
        <span className="text-muted-foreground/50 text-[10px]">
          {data ? relativeTime(data.timestamp) : 'offline'}
        </span>
      </div>

      {/* Mobile: collapsed dot, expandable */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-2 border-b bg-card/50 px-4 py-1.5 text-xs"
        >
          <StatusDot level={level} className="h-2.5 w-2.5" />
          <Activity className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">
            {data ? data.status : 'connecting'}
          </span>
          <div className="flex-1" />
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div className="flex flex-col gap-1 border-b bg-card/50 px-4 py-2 text-xs">
            <button
              type="button"
              onClick={goSettings}
              className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent text-left"
            >
              <Layers className="h-3 w-3 text-muted-foreground" />
              <span className={cn(qLevel === 'red' ? 'text-red-600' : qLevel === 'yellow' ? 'text-yellow-600' : 'text-muted-foreground')}>
                {queueTotal} queued{queueFailed > 0 ? `, ${queueFailed} failed` : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={goSettings}
              className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent text-left"
            >
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground truncate">{lastSkillText}</span>
            </button>
            <button
              type="button"
              onClick={goSettings}
              className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent text-left"
            >
              <DollarSign className="h-3 w-3 text-muted-foreground" />
              <span className={cn(sLevel === 'red' ? 'text-red-600' : sLevel === 'yellow' ? 'text-yellow-600' : 'text-muted-foreground')}>
                ${spentUsd.toFixed(2)} / ${budgetUsd}
              </span>
            </button>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
