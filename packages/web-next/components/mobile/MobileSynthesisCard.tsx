'use client'

import { Brain, Loader2 } from 'lucide-react'
import { useSynthesizeQuery } from '@/lib/api/synthesize.hooks'
import { isSynthesisRequest } from '@/lib/synthesis-detect'

interface MobileSynthesisCardProps {
  query: string
}

export function MobileSynthesisCard({ query }: MobileSynthesisCardProps) {
  const shouldRun = isSynthesisRequest(query) && Boolean(query.trim())

  const { data, isLoading, isError } = useSynthesizeQuery(
    { query },
    { enabled: shouldRun },
  )

  if (!shouldRun) return null

  return (
    <div className="bg-white rounded-lg p-4 border-2 border-book-cloth/20">
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-cloud-dark">
          <Loader2 size={16} className="animate-spin text-book-cloth" />
          <span className="font-body">Synthesizing…</span>
        </div>
      )}

      {isError && (
        <p className="text-sm text-faded-red">
          Synthesis unavailable. Search results shown below.
        </p>
      )}

      {data && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} className="text-book-cloth flex-shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-book-cloth">
              Synthesis · {data.capture_count} source{data.capture_count !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-sm font-body text-slate-medium whitespace-pre-wrap">
            {data.response}
          </p>
        </>
      )}
    </div>
  )
}
