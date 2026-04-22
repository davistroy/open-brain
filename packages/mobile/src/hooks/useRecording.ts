import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import {
  requestMicPermission,
  startRecording,
  stopRecording,
  uploadAudio,
} from '../lib/audio';
import type { VoiceCaptureResponse } from '../lib/types';

type RecordingState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

interface UseRecordingReturn {
  state: RecordingState;
  elapsed: number;
  metering: number;
  result: VoiceCaptureResponse | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
}

export function useRecording(): UseRecordingReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [metering, setMetering] = useState(-160);
  const [result, setResult] = useState<VoiceCaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const start = useCallback(async () => {
    const granted = await requestMicPermission();
    if (!granted) {
      setError('Microphone permission denied');
      setState('error');
      return;
    }

    setElapsed(0);
    setResult(null);
    setError(null);

    const recording = await startRecording();
    recordingRef.current = recording;
    setState('recording');

    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.metering !== undefined) {
        setMetering(status.metering);
      }
    });

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 200);
  }, []);

  const stop = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!recordingRef.current) return;

    setState('uploading');

    try {
      const uri = await stopRecording(recordingRef.current);
      recordingRef.current = null;

      const captureResult = await uploadAudio(uri);
      setResult(captureResult);
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setState('error');
    }
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setElapsed(0);
    setMetering(-160);
    setResult(null);
    setError(null);
  }, []);

  return { state, elapsed, metering, result, error, start, stop, reset };
}
