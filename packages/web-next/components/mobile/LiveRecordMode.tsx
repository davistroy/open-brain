'use client'

import { useEffect } from 'react'
import { Mic, Loader2, AlertCircle } from 'lucide-react'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { useVoiceCapture } from '@/lib/api/voice-captures.hooks'
import { Waveform } from './Waveform'

interface LiveRecordModeProps {
  brainView: string
  onCaptured: () => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export function LiveRecordMode({ brainView, onCaptured }: LiveRecordModeProps) {
  const { phase, elapsed, errorMsg, blob, analyser, start, stop, reset } = useMediaRecorder()
  const voiceCapture = useVoiceCapture()

  // Auto-upload when blob is ready
  useEffect(() => {
    if (phase === 'processing' && blob) {
      const file = new File([blob], 'recording.m4a', { type: blob.type })
      voiceCapture.mutate(
        { file, opts: { brain_view: brainView, device: 'mobile-web' } },
        {
          onSuccess: () => {
            reset()
            onCaptured()
          },
          onError: () => {
            reset()
          },
        },
      )
    }
  }, [phase, blob]) // eslint-disable-line react-hooks/exhaustive-deps

  // Idle state
  if (phase === 'idle' && !voiceCapture.isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <button
          onClick={start}
          className="w-24 h-24 rounded-full bg-book-cloth flex items-center justify-center active:scale-95 transition-transform"
        >
          <Mic className="w-10 h-10 text-white" />
        </button>
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-slate-light">
          Tap to record
        </span>
        <span className="text-[10px] font-mono text-cloud-dark">
          Up to 10 min · auto-classified
        </span>
      </div>
    )
  }

  // Requesting permission
  if (phase === 'requesting-permission') {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="w-24 h-24 rounded-full bg-cloud-medium flex items-center justify-center">
          <Loader2 className="w-10 h-10 text-slate-light animate-spin" />
        </div>
        <span className="text-xs text-slate-light">Allow microphone access…</span>
      </div>
    )
  }

  // Recording
  if (phase === 'recording') {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-faded-red animate-pulse" />
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-faded-red">
            Recording
          </span>
        </div>
        <span className="text-2xl font-mono text-slate-medium tabular-nums">
          {formatTime(elapsed)}
        </span>
        <Waveform analyser={analyser} />
        <button
          onClick={stop}
          className="w-full h-12 bg-faded-red text-white rounded-lg font-body font-medium text-sm"
        >
          Stop Recording
        </button>
      </div>
    )
  }

  // Processing / uploading
  if (phase === 'processing' || voiceCapture.isPending) {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <Loader2 className="w-10 h-10 text-book-cloth animate-spin" />
        <span className="text-xs text-slate-light">Uploading…</span>
      </div>
    )
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <AlertCircle className="w-10 h-10 text-faded-red" />
        <p className="text-xs text-faded-red text-center px-4">
          {errorMsg || 'Microphone blocked. Open Settings → Safari → Microphone.'}
        </p>
        <button
          onClick={start}
          className="px-6 py-2 border border-book-cloth text-book-cloth rounded-lg text-sm"
        >
          Try again
        </button>
      </div>
    )
  }

  return null
}
