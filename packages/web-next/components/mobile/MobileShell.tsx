'use client'

import { useState, useCallback } from 'react'
import { CaptureZone } from './CaptureZone'
import { BottomSheet } from './BottomSheet'
import { TypePicker } from './TypePicker'
import { ViewPicker } from './ViewPicker'
import { MobileSearchBar } from './MobileSearchBar'
import { MobileResultsList } from './MobileResultsList'
import { MobileSynthesisCard } from './MobileSynthesisCard'
import { MobilePullSpinner } from './MobilePullSpinner'
import { Toast } from './Toast'
import { TranscriptEcho } from './TranscriptEcho'
import { useStickyCollapse } from '@/hooks/useStickyCollapse'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'

type CaptureMode = 'text' | 'voice' | 'live'

interface MobileShellProps {
  initialQuery: string
}

export function MobileShell({ initialQuery }: MobileShellProps) {
  const [mode, setMode] = useState<CaptureMode>('text')
  const [captureType, setCaptureType] = useState('observation')
  const [brainView, setBrainView] = useState('technical')
  const [query, setQuery] = useState(initialQuery)
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const [viewPickerOpen, setViewPickerOpen] = useState(false)
  const [toast, setToast] = useState<{ message: string; type?: string } | null>(null)
  const [transcriptEcho, setTranscriptEcho] = useState<{ text: string; duration: number } | null>(null)
  const [searchRefreshKey, setSearchRefreshKey] = useState(0)

  const { collapsed, expand } = useStickyCollapse(200)

  const handleRefresh = useCallback(() => {
    setSearchRefreshKey((k) => k + 1)
  }, [])

  const { pullProgress, isRefreshing, onTouchStart, onTouchMove, onTouchEnd } =
    usePullToRefresh({ onRefresh: handleRefresh })

  function handleCaptured(transcript?: { text: string; duration: number }) {
    if (transcript) {
      setTranscriptEcho(transcript)
    } else {
      setToast({ message: 'Captured!', type: captureType })
    }
  }

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

      {/* Capture zone with sticky-collapse */}
      <section data-zone="capture" className="border-b border-cloud-medium">
        <CaptureZone
          mode={mode}
          onModeChange={setMode}
          captureType={captureType}
          brainView={brainView}
          onOpenTypePicker={() => setTypePickerOpen(true)}
          onOpenViewPicker={() => setViewPickerOpen(true)}
          onCaptured={() => handleCaptured()}
          collapsed={collapsed}
          onExpand={expand}
        />
      </section>

      {/* Search section */}
      <section
        data-zone="search"
        className="flex-1 flex flex-col"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Pull-to-refresh spinner */}
        <MobilePullSpinner pullProgress={pullProgress} isRefreshing={isRefreshing} />

        <div className="px-4 pt-4 pb-3">
          <MobileSearchBar query={query} onQueryChange={setQuery} />
        </div>

        <div className="px-4 pb-8 flex flex-col gap-3" key={searchRefreshKey}>
          {query.trim() && (
            <MobileSynthesisCard query={query} />
          )}
          <MobileResultsList query={query} />
        </div>
      </section>

      {/* Type picker bottom sheet */}
      <BottomSheet
        open={typePickerOpen}
        onClose={() => setTypePickerOpen(false)}
        title="Capture Type"
      >
        <TypePicker
          selected={captureType}
          onSelect={(type) => {
            setCaptureType(type)
            setTypePickerOpen(false)
          }}
        />
      </BottomSheet>

      {/* View picker bottom sheet */}
      <BottomSheet
        open={viewPickerOpen}
        onClose={() => setViewPickerOpen(false)}
        title="Brain View"
      >
        <ViewPicker
          selected={brainView}
          onSelect={(view) => {
            setBrainView(view)
            setViewPickerOpen(false)
          }}
        />
      </BottomSheet>

      {/* Toast notification */}
      <Toast
        message={toast?.message ?? null}
        type={toast?.type}
        onDismiss={() => setToast(null)}
      />

      {/* Transcript echo */}
      <TranscriptEcho
        transcript={transcriptEcho}
        onDismiss={() => setTranscriptEcho(null)}
      />
    </div>
  )
}
