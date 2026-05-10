'use client'

import { useState, useRef, useCallback } from 'react'

export type RecordingPhase = 'idle' | 'requesting-permission' | 'recording' | 'processing' | 'error'

export function useMediaRecorder() {
  const [phase, setPhase] = useState<RecordingPhase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    recorderRef.current?.stop()
  }, [])

  const start = useCallback(async () => {
    setPhase('requesting-permission')
    setErrorMsg(null)
    setBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const preferredMime = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const finalBlob = new Blob(chunksRef.current, { type: recorder.mimeType })
        setBlob(finalBlob)
        setPhase('processing')
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        if (audioCtxRef.current) {
          audioCtxRef.current.close().catch(() => {})
          audioCtxRef.current = null
        }
        setAnalyser(null)
      }

      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const a = audioCtx.createAnalyser()
      a.fftSize = 256
      source.connect(a)
      setAnalyser(a)

      recorder.start(250)
      setPhase('recording')
      const startedAt = Date.now()
      timerRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        setElapsed(seconds)
        if (seconds >= 600) stop()
      }, 250)
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : 'Microphone unavailable')
    }
  }, [stop])

  const reset = useCallback(() => {
    setPhase('idle')
    setElapsed(0)
    setBlob(null)
    setAnalyser(null)
    setErrorMsg(null)
  }, [])

  return { phase, elapsed, errorMsg, blob, analyser, start, stop, reset }
}
