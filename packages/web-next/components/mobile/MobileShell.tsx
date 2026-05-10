'use client'

import { useState } from 'react'
import { CaptureZone } from './CaptureZone'
import { BottomSheet } from './BottomSheet'
import { TypePicker } from './TypePicker'
import { ViewPicker } from './ViewPicker'

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

  function handleCaptured() {
    console.log('Captured!')
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

      {/* Capture zone */}
      <section data-zone="capture" className="border-b border-cloud-medium">
        <CaptureZone
          mode={mode}
          onModeChange={setMode}
          captureType={captureType}
          brainView={brainView}
          onOpenTypePicker={() => setTypePickerOpen(true)}
          onOpenViewPicker={() => setViewPickerOpen(true)}
          onCaptured={handleCaptured}
        />
      </section>

      {/* Search section placeholder */}
      <section
        data-zone="search"
        className="flex-1 flex items-center justify-center p-8"
      >
        <p className="text-sm text-cloud-dark">Search section — Phase E</p>
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
    </div>
  )
}
