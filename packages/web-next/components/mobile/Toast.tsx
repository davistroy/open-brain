'use client'

import { useEffect } from 'react'

interface ToastProps {
  message: string | null
  type?: string
  onDismiss: () => void
}

export function Toast({ message, type, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, 1500)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <div className="fixed bottom-8 left-4 right-4 z-50">
      <div className="bg-slate-dark text-white rounded-lg px-4 py-3 text-sm font-body shadow-lg flex items-center justify-between">
        <span>{message}</span>
        {type && (
          <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-white/60 ml-3">
            {type}
          </span>
        )}
      </div>
    </div>
  )
}
