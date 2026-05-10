'use client'

import { useSearch } from '@/lib/api/search.hooks'
import { MobileResultCard } from './MobileResultCard'
import { MobileEmptyState } from './MobileEmptyState'
import { MobileNoMatch } from './MobileNoMatch'

interface MobileResultsListProps {
  query: string
}

export function MobileResultsList({ query }: MobileResultsListProps) {
  const { data, isLoading, isError } = useSearch({ q: query, limit: 20 })

  if (!query.trim()) {
    return <MobileEmptyState />
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-lg bg-cloud-light animate-pulse h-24"
          />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <p className="text-sm text-faded-red text-center py-8">
        Search failed. Pull to retry.
      </p>
    )
  }

  const results = data?.results ?? []

  if (results.length === 0) {
    return <MobileNoMatch query={query} />
  }

  return (
    <div className="flex flex-col gap-3">
      {results.map(({ capture, score }) => (
        <MobileResultCard key={capture.id} capture={capture} score={score} />
      ))}
    </div>
  )
}
