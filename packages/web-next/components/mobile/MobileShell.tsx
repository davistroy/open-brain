'use client'

import { useState } from 'react'

type CaptureMode = 'text' | 'voice' | 'live'

interface MobileShellProps {
  initialQuery: string
}

export function MobileShell({ initialQuery }: MobileShellProps) {
  const [mode, setMode] = useState<CaptureMode>('text')
  const [captureType, setCaptureType] = useState('observation')
  const [brainView, setBrainView] = useState('technical')
  const [query, setQuery] = useState(initialQuery)

  return (
    <div className="flex flex-col min-h-[100dvh]">
      {/* Eyebrow header */}
      <header
        className="flex items-center justify-between px-4 h-11 border-b border-cloud-medium"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-slate-light">
          Quick Capture
        </span>
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-cloud-dark">
          brain.troy-davis.com
        </span>
      </header>

      {/* Capture zone placeholder */}
      <section
        data-zone="capture"
        className="flex items-center justify-center p-8 border-b border-cloud-medium bg-ivory-light"
      >
        <p className="text-sm text-cloud-dark">Capture zone — Phase C</p>
      </section>

      {/* Search section placeholder */}
      <section
        data-zone="search"
        className="flex-1 flex items-center justify-center p-8"
      >
        <p className="text-sm text-cloud-dark">Search section — Phase E</p>
      </section>
    </div>
  )
}
