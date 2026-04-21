'use client';

import { useState } from 'react';
import { Edit3, Mic, FileUp, Link } from 'lucide-react';
import { Button } from '@/components/design-system';
import type { CaptureType } from '@/lib/types';

type QuickType = 'note' | 'voice' | 'upload' | 'link';

const TYPES: { id: QuickType; label: string; icon: React.ReactNode }[] = [
  { id: 'note',   label: 'Note',   icon: <Edit3 size={13} strokeWidth={1.4} /> },
  { id: 'voice',  label: 'Voice',  icon: <Mic  size={13} strokeWidth={1.4} /> },
  { id: 'upload', label: 'Upload', icon: <FileUp size={13} strokeWidth={1.4} /> },
  { id: 'link',   label: 'Link',   icon: <Link size={13} strokeWidth={1.4} /> },
];

/**
 * QuickCapture — inline capture widget on the dashboard.
 * 'use client' — has textarea + segmented control state.
 * M1: console.log on submit (no API call yet).
 */
export function QuickCapture() {
  const [activeType, setActiveType] = useState<QuickType>('note');
  const [text, setText] = useState('');

  function handleCapture() {
    console.log('[QuickCapture] submit:', { type: activeType, text });
    setText('');
  }

  return (
    <div className="p-[16px]">
      {/* Segmented type control */}
      <div className="flex border border-cloud-light mb-[12px]">
        {TYPES.map((t, i) => {
          const isActive = activeType === t.id;
          const isLast = i === TYPES.length - 1;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveType(t.id)}
              className={[
                'flex-1 px-[10px] py-[7px]',
                'inline-flex items-center justify-center gap-[6px]',
                'font-body text-[12px] tracking-[0.01em]',
                'border-0 cursor-pointer transition-[background,color] duration-[120ms]',
                !isLast ? 'border-r border-cloud-light' : '',
                isActive
                  ? 'bg-slate-medium text-ivory-light font-normal'
                  : 'bg-transparent text-text-body-secondary font-light hover:bg-ivory-dark',
              ].filter(Boolean).join(' ')}
            >
              <span className="inline-flex shrink-0">{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Textarea */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's on your mind?"
        rows={3}
        className={[
          'w-full resize-y',
          'font-body text-[13.5px] font-light',
          'px-[10px] py-[10px]',
          'bg-white border border-cloud-medium rounded-none',
          'text-text-body placeholder:text-text-body-secondary',
          'outline-none transition-[border-color] duration-[120ms]',
          'focus:border-slate-medium',
        ].join(' ')}
        style={{ minHeight: 72 }}
      />

      {/* Footer row */}
      <div className="flex items-center justify-between mt-[10px]">
        <span className="font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em]">
          ⌘↵ TO CAPTURE · ⌘⇧V FOR VOICE
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={handleCapture}
          disabled={!text.trim()}
        >
          Capture
        </Button>
      </div>
    </div>
  );
}
