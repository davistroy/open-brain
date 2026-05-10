'use client'

import { Loader2 } from 'lucide-react'

interface MobilePullSpinnerProps {
  pullProgress: number
  isRefreshing: boolean
}

export function MobilePullSpinner({ pullProgress, isRefreshing }: MobilePullSpinnerProps) {
  const visible = pullProgress > 0 || isRefreshing
  const opacity = isRefreshing ? 1 : pullProgress

  return (
    <div
      className={[
        'flex items-center justify-center transition-all duration-200',
        visible ? 'h-10' : 'h-0 overflow-hidden',
      ].join(' ')}
      style={{ opacity }}
    >
      <Loader2
        size={20}
        className={[
          'text-book-cloth',
          isRefreshing ? 'animate-spin' : '',
        ].join(' ')}
      />
    </div>
  )
}
