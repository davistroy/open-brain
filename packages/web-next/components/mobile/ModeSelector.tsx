'use client'

import { Type, FileAudio, Mic } from 'lucide-react'

type CaptureMode = 'text' | 'voice' | 'live'

interface ModeSelectorProps {
  mode: CaptureMode
  onModeChange: (mode: CaptureMode) => void
}

const TABS: { mode: CaptureMode; label: string; Icon: React.ElementType }[] = [
  { mode: 'text', label: 'Text', Icon: Type },
  { mode: 'voice', label: 'File', Icon: FileAudio },
  { mode: 'live', label: 'Record', Icon: Mic },
]

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  return (
    <div className="flex h-[52px] bg-ivory-light border-b border-cloud-medium">
      {TABS.map(({ mode: tabMode, label, Icon }) => {
        const isActive = mode === tabMode
        return (
          <button
            key={tabMode}
            onClick={() => onModeChange(tabMode)}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors',
              isActive
                ? 'text-book-cloth border-b-2 border-book-cloth'
                : 'text-cloud-dark border-b-2 border-transparent',
            ].join(' ')}
          >
            <Icon size={18} />
            <span className="text-xs font-mono uppercase">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
