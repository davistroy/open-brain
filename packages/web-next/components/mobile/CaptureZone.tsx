'use client'

import { ModeSelector } from './ModeSelector'
import { TextMode } from './TextMode'
import { VoiceFileMode } from './VoiceFileMode'
import { LiveRecordMode } from './LiveRecordMode'

type CaptureMode = 'text' | 'voice' | 'live'

interface CaptureZoneProps {
  mode: CaptureMode
  onModeChange: (mode: CaptureMode) => void
  captureType: string
  brainView: string
  onOpenTypePicker: () => void
  onOpenViewPicker: () => void
  onCaptured: () => void
  collapsed?: boolean
  onExpand?: () => void
}

export function CaptureZone({
  mode,
  onModeChange,
  captureType,
  brainView,
  onOpenTypePicker,
  onOpenViewPicker,
  onCaptured,
  collapsed = false,
  onExpand,
}: CaptureZoneProps) {
  if (collapsed) {
    return (
      <button
        onClick={onExpand}
        className="sticky top-0 z-20 w-full h-14 bg-ivory-light border-b border-cloud-medium flex items-center justify-between px-4 transition-all duration-300"
        aria-label="Expand capture zone"
      >
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-slate-medium">
          Quick Capture
        </span>
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-cloud-dark">
          Tap to expand
        </span>
      </button>
    )
  }

  return (
    <div className="sticky top-0 z-20 bg-ivory-light transition-all duration-300">
      <ModeSelector mode={mode} onModeChange={onModeChange} />

      <div className="px-4 pb-4 pt-3">
        {mode === 'text' && (
          <TextMode
            captureType={captureType}
            brainView={brainView}
            onOpenTypePicker={onOpenTypePicker}
            onOpenViewPicker={onOpenViewPicker}
            onCaptured={onCaptured}
          />
        )}
        {mode === 'voice' && (
          <VoiceFileMode
            brainView={brainView}
            onOpenViewPicker={onOpenViewPicker}
            onCaptured={onCaptured}
          />
        )}
        {mode === 'live' && (
          <LiveRecordMode brainView={brainView} onCaptured={onCaptured} />
        )}
      </div>
    </div>
  )
}
