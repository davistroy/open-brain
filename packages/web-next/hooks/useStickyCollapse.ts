'use client'
import { useState, useEffect, useCallback } from 'react'

export function useStickyCollapse(threshold = 200) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let ticking = false
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(() => {
          setCollapsed(window.scrollY > threshold)
          ticking = false
        })
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])

  const expand = useCallback(() => {
    setCollapsed(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return { collapsed, expand }
}
