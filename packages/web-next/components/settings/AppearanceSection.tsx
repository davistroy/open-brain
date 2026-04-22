'use client';

/**
 * AppearanceSection — Cloudscape screen 11 appearance/wash settings.
 *
 * 4 wash swatches (48×48 squares). Active wash gets a 2px book-cloth border.
 * Click sets localStorage('wash') + updates document.documentElement.dataset.wash.
 *
 * Wash palette (matching the :root defaults and globals.css override blocks):
 *   parchment — warm cream/vellum (default)
 *   kraft     — muted warm tan
 *   moss      — muted green-grey
 *   peach     — soft peach (original :root accent tint)
 */

import { useState, useEffect } from 'react';
import { Palette } from 'lucide-react';

/** Representative background colors for each wash swatch. */
const WASH_OPTIONS = [
  {
    key: 'parchment',
    label: 'Parchment',
    swatchBg: '#EFE6D8',
    swatchBorder: '#DACDB6',
    description: 'Warm cream — default',
  },
  {
    key: 'kraft',
    label: 'Kraft',
    swatchBg: '#FAF1E9',
    swatchBorder: '#EBD8C0',
    description: 'Muted warm tan',
  },
  {
    key: 'moss',
    label: 'Moss',
    swatchBg: '#EEF1EC',
    swatchBorder: '#D4DDCF',
    description: 'Muted green-grey',
  },
  {
    key: 'peach',
    label: 'Peach',
    swatchBg: '#FBEFE9',
    swatchBorder: '#F2D5C6',
    description: 'Soft warm peach',
  },
] as const;

type WashKey = (typeof WASH_OPTIONS)[number]['key'];

function getStoredWash(): WashKey {
  if (typeof window === 'undefined') return 'parchment';
  try {
    const stored = localStorage.getItem('wash');
    const valid: WashKey[] = ['parchment', 'kraft', 'moss', 'peach'];
    return (valid.includes(stored as WashKey) ? stored : 'parchment') as WashKey;
  } catch {
    return 'parchment';
  }
}

function applyWash(wash: WashKey) {
  document.documentElement.dataset.wash = wash;
  try {
    localStorage.setItem('wash', wash);
  } catch {
    // private browsing — ignore
  }
}

export function AppearanceSection() {
  const [activeWash, setActiveWash] = useState<WashKey>('parchment');

  // Read stored wash on mount (client-side only)
  useEffect(() => {
    setActiveWash(getStoredWash());
  }, []);

  function handleWashSelect(wash: WashKey) {
    setActiveWash(wash);
    applyWash(wash);
  }

  return (
    <div className="bg-bg-container border border-cloud-light px-8 py-10">
      {/* Section heading */}
      <div className="flex items-center gap-3 mb-6 pb-6 border-b border-cloud-light">
        <div className="w-8 h-8 flex items-center justify-center border border-cloud-light shrink-0">
          <Palette size={15} strokeWidth={1.3} className="text-cloud-dark" />
        </div>
        <h2 className="font-display text-[17px] font-normal tracking-[-0.01em] text-text-heading">
          Appearance
        </h2>
      </div>

      {/* Wash selector */}
      <div className="mb-8">
        <p className="text-[12px] font-mono uppercase tracking-[0.07em] text-text-small mb-4">
          Canvas wash
        </p>

        <div className="flex gap-4 flex-wrap">
          {WASH_OPTIONS.map((wash) => {
            const isActive = activeWash === wash.key;
            return (
              <button
                key={wash.key}
                type="button"
                onClick={() => handleWashSelect(wash.key)}
                aria-pressed={isActive}
                aria-label={`${wash.label} wash${isActive ? ' (active)' : ''}`}
                className={[
                  'group flex flex-col items-center gap-2 cursor-pointer bg-transparent border-0 p-0',
                  'focus-visible:outline-2 focus-visible:outline-offset-2',
                  'focus-visible:outline-[var(--color-book-cloth)]',
                ].join(' ')}
              >
                {/* 48×48 swatch */}
                <div
                  style={{
                    width: 48,
                    height: 48,
                    background: wash.swatchBg,
                    border: isActive
                      ? '2px solid var(--color-book-cloth)'
                      : `1px solid ${wash.swatchBorder}`,
                    // Inner inset highlight to show the accent tint
                    boxShadow: isActive
                      ? 'inset 0 0 0 3px rgba(255,255,255,0.45)'
                      : 'none',
                    transition: 'border var(--motion-duration-fast)',
                    outline: 'none',
                  }}
                />
                {/* Label */}
                <span
                  className={[
                    'text-[11px] leading-[14px]',
                    isActive
                      ? 'text-[var(--color-book-cloth-dark)] font-medium'
                      : 'text-text-small font-normal',
                  ].join(' ')}
                >
                  {wash.label}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-5 text-[12px] text-text-small font-light leading-[1.6] max-w-[400px]">
          Wash changes the canvas tint across the entire interface. Paired with dark mode for full
          control — the dark mode toggle is in the top navigation bar.
        </p>
      </div>

      {/* Dark mode note */}
      <div
        className="border-t border-cloud-light pt-6"
        style={{ borderTopStyle: 'dashed' }}
      >
        <p className="text-[12px] font-mono uppercase tracking-[0.07em] text-text-small mb-2">
          System theme
        </p>
        <p className="text-[12px] text-text-small font-light leading-[1.6] max-w-[440px]">
          Light and dark mode are controlled by the toggle in the top navigation bar. Wash works in
          both light and dark mode.
        </p>
      </div>
    </div>
  );
}
