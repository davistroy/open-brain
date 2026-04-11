import { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { TranscriptTurn } from '@/lib/types';

function formatTurnTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface TranscriptViewerProps {
  turns: TranscriptTurn[];
  className?: string;
  /** Auto-scroll to bottom when new turns arrive (for active sessions) */
  autoScroll?: boolean;
}

export default function TranscriptViewer({ turns, className, autoScroll }: TranscriptViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [turns.length, autoScroll]);

  if (turns.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-10 text-sm text-muted-foreground', className)}>
        No transcript available.
      </div>
    );
  }

  return (
    <div className={cn('space-y-3 overflow-y-auto', className)}>
      {turns.map((turn, i) => {
        const isUser = turn.role === 'user';
        return (
          <div
            key={i}
            className={cn(
              'flex flex-col max-w-[80%]',
              isUser ? 'items-start self-start' : 'items-end self-end ml-auto',
            )}
          >
            <div
              className={cn(
                'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                isUser
                  ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100 rounded-bl-md'
                  : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100 rounded-br-md',
              )}
            >
              {turn.text}
            </div>
            <span className="text-[10px] text-muted-foreground mt-1 px-1">
              {isUser ? 'You' : 'Brain'} &middot; {formatTurnTime(turn.timestamp)}
            </span>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
