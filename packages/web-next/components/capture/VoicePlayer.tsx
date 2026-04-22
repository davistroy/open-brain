'use client';

/**
 * VoicePlayer — inline dark-background audio player for voice captures.
 *
 * Rendered between CaptureHeader and TranscriptView on the capture detail page.
 * Self-contained: owns its own <audio> element (not the floating global AudioPlayer).
 *
 * Features:
 *  - Slate-dark background with book-cloth play/pause button (40x40 circle)
 *  - Waveform SVG: 2px bars, variable height (seeded pseudo-random from duration),
 *    played portion = book-cloth, unplayed = cloud-dark
 *  - Progress tracking via timeupdate event on <audio> ref
 *  - Mono timestamp counter (MM:SS / MM:SS) with tabular-nums
 *  - Seek by clicking waveform
 *  - Conditionally rendered: only shown when source === 'voice' (or slack with audio_url)
 *    and source_metadata.audio_url is present
 */

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { CaptureSource, CaptureSourceMetadata } from '@/lib/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VoicePlayerProps {
  source: CaptureSource;
  source_metadata?: CaptureSourceMetadata | null;
}

// ---------------------------------------------------------------------------
// Waveform generation
// ---------------------------------------------------------------------------

const BAR_COUNT = 60;
const BAR_WIDTH = 2;     // px
const BAR_GAP = 3;       // px between bars
const BAR_MIN_HEIGHT = 4;
const BAR_MAX_HEIGHT = 32;
const WAVEFORM_HEIGHT = 40;

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Using the duration as a seed produces a consistent waveform per capture
 * without requiring stored waveform data.
 */
function seededRandom(seed: number) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateBarHeights(durationSecs: number): number[] {
  // Use a whole-second seed so captures with the same duration look the same.
  const rand = seededRandom(Math.round(durationSecs) || 30);
  return Array.from({ length: BAR_COUNT }, () => {
    const r = rand();
    // Smooth the variance — bias toward mid-range heights for realism.
    const biased = 0.3 + r * 0.7;
    return Math.round(BAR_MIN_HEIGHT + biased * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT));
  });
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Returns null when the capture should not show a player (no audio_url, or
 * source type is not voice/audio-capable). Caller can render unconditionally.
 */
export function VoicePlayer({ source, source_metadata }: VoicePlayerProps) {
  const audioUrl = source_metadata?.audio_url;
  const durationSecs = source_metadata?.duration ?? 60;

  // Only render for voice or slack-with-audio captures that have a URL.
  const isAudioCapture = source === 'voice' || (source === 'slack' && !!audioUrl);
  if (!isAudioCapture || !audioUrl) return null;

  return <VoicePlayerInner audioUrl={audioUrl} durationSecs={durationSecs} />;
}

// ---------------------------------------------------------------------------
// Inner player (always has audioUrl — conditional logic above handles guard)
// ---------------------------------------------------------------------------

interface VoicePlayerInnerProps {
  audioUrl: string;
  durationSecs: number;
}

function VoicePlayerInner({ audioUrl, durationSecs }: VoicePlayerInnerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState<number>(durationSecs);

  const barHeights = generateBarHeights(loadedDuration);
  const totalWidth = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
  const progress = loadedDuration > 0 ? currentTime / loadedDuration : 0;

  // Wire audio events.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Capture non-null reference for use inside closures (TS null-flow doesn't
    // carry the `if (!audio) return` guard into nested function bodies).
    const el: HTMLAudioElement = audio;

    function onPlay() { setIsPlaying(true); }
    function onPause() { setIsPlaying(false); }
    function onEnded() { setIsPlaying(false); setCurrentTime(0); }
    function onTimeUpdate() { setCurrentTime(el.currentTime); }
    function onLoadedMetadata() {
      if (isFinite(el.duration) && el.duration > 0) {
        setLoadedDuration(el.duration);
      }
    }

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('loadedmetadata', onLoadedMetadata);

    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, []);

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => {
        // Browser autoplay policy — user gesture should allow this.
      });
    }
  }

  function handleWaveformClick(e: React.MouseEvent<SVGSVGElement>) {
    const audio = audioRef.current;
    if (!audio || loadedDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const newTime = ratio * loadedDuration;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  }

  return (
    <div
      className="flex items-center gap-4 px-5 py-4"
      style={{
        background: 'var(--color-slate-dark)',
        borderRadius: 0,
      }}
      role="region"
      aria-label="Voice recording player"
    >
      {/* Hidden native <audio> element — all control via JS */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      {/* Play / Pause button — 40x40 book-cloth circle */}
      <button
        onClick={togglePlayPause}
        className="flex items-center justify-center shrink-0 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-book-cloth focus-visible:ring-offset-2"
        style={{
          width: 40,
          height: 40,
          background: 'var(--color-book-cloth)',
          color: '#FFFFFF',
          flexShrink: 0,
        }}
        aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
      >
        {isPlaying ? (
          <Pause size={15} strokeWidth={2} />
        ) : (
          <Play size={15} strokeWidth={2} style={{ marginLeft: 1 }} />
        )}
      </button>

      {/* Waveform SVG */}
      <svg
        width={totalWidth}
        height={WAVEFORM_HEIGHT}
        viewBox={`0 0 ${totalWidth} ${WAVEFORM_HEIGHT}`}
        className="flex-1 cursor-pointer"
        style={{ maxWidth: totalWidth, minWidth: 80, overflow: 'visible' }}
        onClick={handleWaveformClick}
        role="slider"
        aria-label="Playback position"
        aria-valuenow={Math.round(currentTime)}
        aria-valuemin={0}
        aria-valuemax={Math.round(loadedDuration)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(loadedDuration)}`}
      >
        {barHeights.map((height, i) => {
          const x = i * (BAR_WIDTH + BAR_GAP);
          const y = (WAVEFORM_HEIGHT - height) / 2;
          // Fraction of the way through the waveform this bar falls.
          const barProgress = i / (BAR_COUNT - 1);
          const isPlayed = barProgress <= progress;

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={BAR_WIDTH}
              height={height}
              style={{
                fill: isPlayed
                  ? 'var(--color-book-cloth)'
                  : 'var(--color-cloud-dark)',
                transition: 'fill 60ms linear',
              }}
            />
          );
        })}
      </svg>

      {/* Timestamp counter: current / total — mono, tabular-nums */}
      <div
        className="shrink-0 tabular-nums"
        style={{
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--color-cloud-medium)',
          whiteSpace: 'nowrap',
          fontFeatureSettings: '"tnum" 1',
          minWidth: 72,
          textAlign: 'right',
        }}
        aria-live="off"
      >
        {formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(loadedDuration)}
      </div>
    </div>
  );
}
