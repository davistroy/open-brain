'use client';

import { useState } from 'react';
import { Play, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Eyebrow, Button } from '@/components/design-system';
import { briefsApi } from '@/lib/api-client';
import { useAudioPlayer } from '@/components/audio/AudioPlayer';
import { BriefFollowUp } from '@/components/briefs/BriefFollowUp';
import { BriefExportMenu } from '@/components/briefs/BriefExportMenu';
import type { TocItem } from '@/lib/types';

interface BriefTocProps {
  items: TocItem[];
  /** Brief ID — needed to fetch audio for the Listen button. */
  briefId: string;
  /** Brief title — shown in the floating player and used for export filename. */
  briefTitle: string;
  /**
   * Estimated read duration in seconds.
   * Derived by caller from `meta` text ("X min read"). Shown in button label
   * and passed to the audio player as an optimistic duration until metadata loads.
   * Defaults to 0 (unknown).
   */
  estimatedDurationSecs?: number;
  /**
   * Pre-rendered HTML body of the brief.
   * Passed to BriefExportMenu for Markdown download and print.
   * Optional — export menu handles empty body gracefully.
   */
  bodyHtml?: string;
}

/**
 * Brief table-of-contents sidebar.
 * Sticky left column (220px) — "ON THIS PAGE" eyebrow, section anchor links,
 * then an ACTIONS group with three utility buttons.
 * Active item highlighted with 2px terracotta left border.
 *
 * Listen: fetches TTS audio blob, passes to AudioPlayerProvider, auto-plays.
 * Export: opens BriefExportMenu dropdown (Markdown download + Print to PDF).
 * Ask follow-up: inline question input via BriefFollowUp.
 *
 * 'use client' — audio fetch + useAudioPlayer require client context.
 */
export function BriefToc({
  items,
  briefId,
  briefTitle,
  estimatedDurationSecs = 0,
  bodyHtml = '',
}: BriefTocProps) {
  const audioPlayer = useAudioPlayer();
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);

  async function handleListen() {
    if (isLoadingAudio) return;
    setIsLoadingAudio(true);
    try {
      const blob = await briefsApi.audio(briefId);
      audioPlayer.play(blob, briefTitle, estimatedDurationSecs || undefined);
    } catch {
      toast.error('Could not load audio — please try again.');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  // Format estimated read time label (e.g. "4 min") for the Listen button.
  const durationLabel =
    estimatedDurationSecs > 0
      ? `${Math.round(estimatedDurationSecs / 60)} min`
      : '';

  return (
    <aside className="sticky top-[22px]">
      <Eyebrow>ON THIS PAGE</Eyebrow>

      <nav className="flex flex-col">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={[
              'block text-[12.5px] py-[6px] pr-[10px] pl-[10px] -ml-[10px]',
              'leading-[1.4] no-underline transition-colors duration-[120ms]',
              item.active
                ? 'border-l-[2px] border-book-cloth text-text-heading font-normal'
                : 'border-l-[2px] border-transparent text-text-body-secondary font-light hover:text-text-heading',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="mt-[20px] pt-[16px] border-t border-cloud-light">
        <Eyebrow>ACTIONS</Eyebrow>
        <div className="flex flex-col gap-[6px] mt-[8px]">
          <Button
            variant="secondary"
            size="sm"
            icon={<Play size={11} strokeWidth={1.5} />}
            onClick={handleListen}
            disabled={isLoadingAudio}
          >
            {isLoadingAudio
              ? 'Loading…'
              : durationLabel
                ? `Listen · ${durationLabel}`
                : 'Listen'}
          </Button>
          <BriefExportMenu title={briefTitle} bodyHtml={bodyHtml}>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={11} strokeWidth={1.5} />}
            >
              Export
            </Button>
          </BriefExportMenu>
        </div>
      </div>

      {/* Follow-up questions — inline expansion below action group */}
      <div className="mt-[4px] pt-[10px] border-t border-cloud-light">
        <BriefFollowUp briefTitle={briefTitle} />
      </div>
    </aside>
  );
}
