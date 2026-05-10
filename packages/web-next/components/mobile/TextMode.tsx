'use client'

import { useRef, useEffect, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useCreateCapture } from '@/lib/api/captures.hooks'
import type { CaptureType, BrainView } from '@/lib/types'

interface TextModeProps {
  captureType: string
  brainView: string
  onOpenTypePicker: () => void
  onOpenViewPicker: () => void
  onCaptured: () => void
}

export function TextMode({
  captureType,
  brainView,
  onOpenTypePicker,
  onOpenViewPicker,
  onCaptured,
}: TextModeProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { mutate, isPending } = useCreateCapture()

  // Auto-expand textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  function handleSubmit() {
    if (!text.trim() || isPending) return
    mutate(
      {
        content: text.trim(),
        capture_type: captureType as CaptureType,
        brain_view: brainView as BrainView,
        source: 'api',
      },
      {
        onSuccess: () => {
          setText('')
          onCaptured()
        },
      }
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's on your mind?"
        rows={3}
        className="min-h-[88px] max-h-[220px] resize-none bg-white border border-cloud-medium rounded-lg p-3 w-full text-sm font-body focus:outline-none focus:ring-2 focus:ring-book-cloth focus:border-book-cloth transition-colors"
        style={{ overflowY: text.length > 200 ? 'auto' : 'hidden' }}
      />

      {/* Char count */}
      <div className="flex justify-end -mt-2">
        <span className="text-[10px] font-mono text-cloud-dark">
          {text.length} / 50,000
        </span>
      </div>

      {/* Picker pills */}
      <div className="flex gap-2">
        <button
          onClick={onOpenTypePicker}
          className="border border-cloud-medium rounded-full px-3 py-1.5 text-xs font-mono uppercase flex items-center gap-1 text-slate-medium hover:bg-ivory-light transition-colors"
        >
          {captureType}
          <ChevronDown size={14} />
        </button>
        <button
          onClick={onOpenViewPicker}
          className="border border-cloud-medium rounded-full px-3 py-1.5 text-xs font-mono uppercase flex items-center gap-1 text-slate-medium hover:bg-ivory-light transition-colors"
        >
          {brainView.replace(/-/g, ' ')}
          <ChevronDown size={14} />
        </button>
      </div>

      {/* Capture button */}
      <button
        onClick={handleSubmit}
        disabled={!text.trim() || isPending}
        className="w-full h-12 bg-book-cloth text-white rounded-lg font-body font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2 transition-opacity"
      >
        {isPending ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Saving…
          </>
        ) : (
          'Capture'
        )}
      </button>
    </div>
  )
}
