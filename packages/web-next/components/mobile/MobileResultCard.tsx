'use client'

import type { Capture } from '@/lib/types'

// The API may include a tags array not present in the shared Capture type
type CaptureWithTags = Capture & { tags?: string[] | null }

interface MobileResultCardProps {
  capture: CaptureWithTags
  score: number
}

function relativeDate(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  const diffWeeks = Math.floor(diffDays / 7)
  return `${diffWeeks}w ago`
}

export function MobileResultCard({ capture, score }: MobileResultCardProps) {
  const tags = capture.tags ?? []
  const visibleTags = tags.slice(0, 3)
  const extraCount = tags.length - visibleTags.length

  const scorePercent = `${Math.round(score * 100)}%`

  return (
    <div className="bg-white rounded-lg p-3 border border-cloud-light">
      {/* Top row */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono uppercase text-cloud-dark">
          {capture.source} · {relativeDate(capture.created_at)}
        </span>
        <span className="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase bg-cloud-light text-slate-light">
          {capture.capture_type}
        </span>
      </div>

      {/* Content preview */}
      <p className="line-clamp-2 text-sm text-slate-medium mb-2">
        {capture.content}
      </p>

      {/* Bottom row */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-cloud-dark">
          {visibleTags.join(', ')}
          {extraCount > 0 && ` +${extraCount}`}
        </span>
        <span className="text-[10px] font-mono text-cloud-dark">
          {scorePercent}
        </span>
      </div>
    </div>
  )
}
