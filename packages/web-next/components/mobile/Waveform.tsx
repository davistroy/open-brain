'use client'

import { useRef, useEffect } from 'react'

interface WaveformProps {
  analyser: AnalyserNode | null
}

const BAR_COUNT = 32

export function Waveform({ analyser }: WaveformProps) {
  const barsRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (!analyser || !barsRef.current) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const bars = barsRef.current.children

    const draw = () => {
      analyser.getByteFrequencyData(dataArray)
      const step = Math.floor(dataArray.length / BAR_COUNT)
      for (let i = 0; i < BAR_COUNT; i++) {
        const value = dataArray[i * step] / 255
        const height = Math.max(4, value * 48)
        const bar = bars[i] as HTMLElement | undefined
        if (bar) bar.style.height = `${height}px`
      }
      rafRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [analyser])

  return (
    <div ref={barsRef} className="flex items-end justify-center gap-[3px] h-12">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div
          key={i}
          className="w-[4px] rounded-full bg-faded-red transition-[height] duration-75"
          style={{ height: '4px' }}
        />
      ))}
    </div>
  )
}
