'use client'

import { ModeSelector } from './ModeSelector'
import { TextMode } from './TextMode'
import { VoiceFileMode } from './VoiceFileMode'

type CaptureMode = 'text' | 'voice' | 'live'

interface CaptureZoneProps {
  mode: CaptureMode
  onModeChange: (mode: CaptureMode) => void
  captureType: string
  brainView: string
  onOpenTypePicker: () => void
  onOpenViewPicker: () => void
  onCaptured: () => void
}

export function CaptureZone({
  mode,
  onModeChange,
  captureType,
  brainView,
  onOpenTypePicker,
  onOpenViewPicker,
  onCaptured,
}: CaptureZoneProps) {
  return (
    <div className="sticky top-0 z-20 bg-ivory-light">
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
          <div className="flex items-center justify-center py-8 text-sm text-cloud-dark font-body">
            Live recording — Phase D
          </div>
        )}
      </div>
    </div>
  )
}
