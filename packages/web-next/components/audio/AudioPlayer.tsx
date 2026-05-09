'use client';

/**
 * AudioPlayer — floating mini-player that persists across navigation.
 *
 * Architecture:
 *   - AudioPlayerContext: React context holding player state + controls.
 *     Exported so any component can call `useAudioPlayer()` to trigger playback.
 *   - AudioPlayerProvider: wraps app in providers.tsx (client tree).
 *   - AudioPlayer: floating fixed-bottom UI. Mount once in shell layout via
 *     AudioPlayerMount (thin client wrapper).
 *
 * Playback flow:
 *   1. Component calls `play(blob, title, durationSecs?)`.
 *   2. Context creates an object URL, sets audio.src, calls audio.play().
 *   3. Player renders; native audio events drive progress state.
 *   4. Close revokes the object URL and resets state.
 *
 * Navigation: the provider lives outside the shell RSC layout so the Audio
 * element survives route transitions (Next.js App Router keeps the provider
 * subtree mounted). The floating UI is injected via AudioPlayerMount client
 * wrapper inside layout.tsx.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pause, Play, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Speed = 1 | 1.5 | 2;

interface AudioPlayerState {
  isVisible: boolean;
  isPlaying: boolean;
  title: string;
  currentTime: number;   // seconds
  duration: number;      // seconds (may be 0 until metadata loaded)
  speed: Speed;
}

interface AudioPlayerContextValue extends AudioPlayerState {
  /** Start playback from a Blob. `estimatedSecs` is shown until metadata loads. */
  play: (blob: Blob, title: string, estimatedSecs?: number) => void;
  pause: () => void;
  resume: () => void;
  seek: (secs: number) => void;
  setSpeed: (speed: Speed) => void;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerContext);
  if (!ctx) {
    throw new Error('useAudioPlayer must be used within AudioPlayerProvider');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [state, setState] = useState<AudioPlayerState>({
    isVisible: false,
    isPlaying: false,
    title: '',
    currentTime: 0,
    duration: 0,
    speed: 1,
  });

  // Lazily create the Audio element once (client-side only).
  function getAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  }

  // Wire native audio events → React state.
  useEffect(() => {
    const audio = getAudio();

    function onPlay() {
      setState((s) => ({ ...s, isPlaying: true }));
    }
    function onPause() {
      setState((s) => ({ ...s, isPlaying: false }));
    }
    function onTimeUpdate() {
      setState((s) => ({ ...s, currentTime: audio.currentTime }));
    }
    function onLoadedMetadata() {
      setState((s) => ({
        ...s,
        duration: isFinite(audio.duration) ? audio.duration : s.duration,
      }));
    }
    function onEnded() {
      setState((s) => ({ ...s, isPlaying: false, currentTime: 0 }));
    }

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const play = useCallback((blob: Blob, title: string, estimatedSecs?: number) => {
    const audio = getAudio();

    // Revoke previous object URL to avoid memory leak.
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    const url = URL.createObjectURL(blob);
    objectUrlRef.current = url;
    audio.src = url;
    audio.playbackRate = state.speed;

    setState((s) => ({
      ...s,
      isVisible: true,
      isPlaying: false,         // will flip to true in onPlay handler
      title,
      currentTime: 0,
      duration: estimatedSecs ?? 0,
    }));

    audio.play().catch(() => {
      // Browser may block autoplay — user can hit play manually.
    });
  }, [state.speed]);

  const pause = useCallback(() => {
    getAudio().pause();
  }, []);

  const resume = useCallback(() => {
    getAudio().play().catch(() => {});
  }, []);

  const seek = useCallback((secs: number) => {
    const audio = getAudio();
    audio.currentTime = secs;
    setState((s) => ({ ...s, currentTime: secs }));
  }, []);

  const setSpeed = useCallback((speed: Speed) => {
    getAudio().playbackRate = speed;
    setState((s) => ({ ...s, speed }));
  }, []);

  const close = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    audio.src = '';
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setState({
      isVisible: false,
      isPlaying: false,
      title: '',
      currentTime: 0,
      duration: 0,
      speed: 1,
    });
  }, []);

  const value: AudioPlayerContextValue = {
    ...state,
    play,
    pause,
    resume,
    seek,
    setSpeed,
    close,
  };

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SPEEDS: Speed[] = [1, 1.5, 2];

function nextSpeed(current: Speed): Speed {
  const idx = SPEEDS.indexOf(current);
  return SPEEDS[(idx + 1) % SPEEDS.length]!;
}

// ---------------------------------------------------------------------------
// FloatingPlayer UI
// ---------------------------------------------------------------------------

/**
 * Floating mini-player. Mount once inside the shell layout via AudioPlayerMount.
 * Hidden when no audio is loaded (isVisible = false).
 */
export function AudioPlayer() {
  const {
    isVisible,
    isPlaying,
    title,
    currentTime,
    duration,
    speed,
    pause,
    resume,
    seek,
    setSpeed,
    close,
  } = useAudioPlayer();

  if (!isVisible) return null;

  const progress = duration > 0 ? currentTime / duration : 0;

  function handleProgressClick(e: React.MouseEvent<HTMLDivElement>) {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seek(ratio * duration);
  }

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 flex items-center gap-[12px] px-[20px] py-[10px]"
      style={{
        background: 'var(--color-ivory-deep, #2c2825)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.25)',
      }}
      role="region"
      aria-label="Audio player"
    >
      {/* Play / Pause */}
      <button
        onClick={isPlaying ? pause : resume}
        className="flex items-center justify-center w-[32px] h-[32px] rounded-full shrink-0 transition-opacity hover:opacity-80"
        style={{ background: 'var(--color-book-cloth, #8b5e3c)', color: '#fff' }}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause size={13} strokeWidth={2} />
        ) : (
          <Play size={13} strokeWidth={2} />
        )}
      </button>

      {/* Title */}
      <span
        className="text-[12px] font-light leading-[1.3] max-w-[200px] truncate shrink-0"
        style={{ color: 'rgba(255,255,255,0.85)' }}
        title={title}
      >
        {title}
      </span>

      {/* Time: current */}
      <span
        className="text-[11px] font-mono shrink-0 tabular-nums"
        style={{ color: 'rgba(255,255,255,0.5)' }}
      >
        {formatTime(currentTime)}
      </span>

      {/* Progress bar */}
      <div
        className="flex-1 h-[4px] rounded-full cursor-pointer relative"
        style={{ background: 'rgba(255,255,255,0.15)', minWidth: 60 }}
        onClick={handleProgressClick}
        role="slider"
        aria-label="Playback position"
        aria-valuenow={Math.round(currentTime)}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
      >
        <div
          className="absolute top-0 left-0 h-full rounded-full transition-[width] duration-[100ms]"
          style={{
            width: `${(progress * 100).toFixed(1)}%`,
            background: 'var(--color-book-cloth, #8b5e3c)',
          }}
        />
      </div>

      {/* Time: duration */}
      <span
        className="text-[11px] font-mono shrink-0 tabular-nums"
        style={{ color: 'rgba(255,255,255,0.5)' }}
      >
        {formatTime(duration)}
      </span>

      {/* Speed toggle */}
      <button
        onClick={() => setSpeed(nextSpeed(speed))}
        className="text-[11px] font-mono shrink-0 px-[6px] py-[2px] rounded transition-opacity hover:opacity-80"
        style={{
          background: 'rgba(255,255,255,0.1)',
          color: 'rgba(255,255,255,0.7)',
          minWidth: 36,
        }}
        aria-label={`Playback speed: ${speed}x. Click to change.`}
      >
        {speed}×
      </button>

      {/* Close */}
      <button
        onClick={close}
        className="flex items-center justify-center w-[24px] h-[24px] shrink-0 rounded transition-opacity hover:opacity-70"
        style={{ color: 'rgba(255,255,255,0.45)' }}
        aria-label="Close player"
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AudioPlayerMount — thin client wrapper for RSC shell layout
// ---------------------------------------------------------------------------

/**
 * Mounts the floating AudioPlayer inside the RSC shell layout.
 * Must be 'use client' so it can access the AudioPlayerContext.
 *
 * Usage in layout.tsx:
 *   import { AudioPlayerMount } from '@/components/audio/AudioPlayer'
 *   // inside JSX: <AudioPlayerMount />
 */
export function AudioPlayerMount() {
  return <AudioPlayer />;
}
