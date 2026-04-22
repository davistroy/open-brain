'use client';

import { useState } from 'react';
import { Edit3, Mic, FileUp, Link } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/design-system';
import { capturesApi } from '@/lib/api-client';
import type { CaptureType } from '@/lib/types';

type QuickType = 'note' | 'voice' | 'upload' | 'link';

const TYPES: { id: QuickType; label: string; icon: React.ReactNode }[] = [
  { id: 'note',   label: 'Note',   icon: <Edit3 size={13} strokeWidth={1.4} /> },
  { id: 'voice',  label: 'Voice',  icon: <Mic  size={13} strokeWidth={1.4} /> },
  { id: 'upload', label: 'Upload', icon: <FileUp size={13} strokeWidth={1.4} /> },
  { id: 'link',   label: 'Link',   icon: <Link size={13} strokeWidth={1.4} /> },
];

/** Map QuickType to a valid CaptureType for the API */
function toCaptureType(_quickType: QuickType): CaptureType {
  // All quick-capture modes submit as 'observation'; richer classification
  // happens in the pipeline (extract stage).
  return 'observation';
}

/**
 * QuickCapture — inline capture widget on the dashboard.
 * 'use client' — has textarea + segmented control state.
 * M2: wired to capturesApi.create via useMutation.
 *   onSuccess → router.refresh() (re-fetches RSC data) + sonner toast.
 */
export function QuickCapture() {
  const [activeType, setActiveType] = useState<QuickType>('note');
  const [text, setText] = useState('');
  const router = useRouter();

  const mutation = useMutation({
    mutationFn: () =>
      capturesApi.create({
        content: text.trim(),
        capture_type: toCaptureType(activeType),
        brain_view: 'personal',
        source: 'api',
      }),
    onSuccess: () => {
      setText('');
      toast('Captured');
      // Refresh the RSC page so StatStrip + RecentCaptures re-fetch.
      router.refresh();
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : 'Failed to capture — please try again.';
      toast.error(message);
    },
  });

  function handleCapture() {
    if (!text.trim()) return;
    mutation.mutate();
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
          disabled={!text.trim() || mutation.isPending}
        >
          {mutation.isPending ? 'Capturing…' : 'Capture'}
        </Button>
      </div>
    </div>
  );
}
