'use client'
import { useState, useRef, useCallback } from 'react'

interface PullToRefreshOptions {
  onRefresh: () => void | Promise<void>
  threshold?: number
}

export function usePullToRefresh({ onRefresh, threshold = 60 }: PullToRefreshOptions) {
  const [pullProgress, setPullProgress] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const startY = useRef(0)
  const pulling = useRef(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY === 0) {
      startY.current = e.touches[0].clientY
      pulling.current = true
    }
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling.current) return
    const delta = e.touches[0].clientY - startY.current
    if (delta > 0) {
      setPullProgress(Math.min(delta / threshold, 1))
    }
  }, [threshold])

  const onTouchEnd = useCallback(async () => {
    if (!pulling.current) return
    pulling.current = false
    if (pullProgress >= 1) {
      setIsRefreshing(true)
      try { await onRefresh() } finally {
        setIsRefreshing(false)
      }
    }
    setPullProgress(0)
  }, [pullProgress, onRefresh])

  return { pullProgress, isRefreshing, onTouchStart, onTouchMove, onTouchEnd }
}
