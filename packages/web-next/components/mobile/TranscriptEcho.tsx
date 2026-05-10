'use client'

import { useEffect } from 'react'
import { CheckCircle } from 'lucide-react'

interface TranscriptEchoProps {
  transcript: { text: string; duration: number } | null
  onDismiss: () => void
}

export function TranscriptEcho({ transcript, onDismiss }: TranscriptEchoProps) {
  useEffect(() => {
    if (!transcript) return
    const timer = setTimeout(onDismiss, 3000)
    return () => clearTimeout(timer)
  }, [transcript, onDismiss])

  if (!transcript) return null

  return (
    <div className="fixed bottom-8 left-4 right-4 z-50">
      <div className="bg-white rounded-lg p-4 border-2 border-moss/30 shadow-lg">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle size={16} className="text-moss flex-shrink-0" />
          <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-moss">
            Voice Captured · {transcript.duration}s
          </span>
        </div>
        <p className="text-sm text-slate-medium line-clamp-3">
          {transcript.text}
        </p>
      </div>
    </div>
  )
}
