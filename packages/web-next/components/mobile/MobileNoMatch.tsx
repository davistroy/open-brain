'use client'

interface MobileNoMatchProps {
  query: string
}

export function MobileNoMatch({ query }: MobileNoMatchProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 px-4">
      <p className="text-sm text-slate-medium text-center">
        No results for &ldquo;{query}&rdquo;
      </p>
      <p className="text-xs text-cloud-dark text-center">
        Try different terms or a shorter phrase.
      </p>
    </div>
  )
}
