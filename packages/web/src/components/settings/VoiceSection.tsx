import { Mic } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { IntegrationStatus } from '@/lib/types';

export interface VoiceSectionProps {
  integrations: IntegrationStatus[];
  voiceStats: { totalSessions: number; activeSessions: number } | null;
  loading: boolean;
}

export function VoiceSection({ integrations, voiceStats, loading }: VoiceSectionProps) {
  const pipecatIntegration = integrations.find(i => i.name.toLowerCase().includes('pipecat') || i.name.toLowerCase().includes('voice'));
  const voiceCaptureIntegration = integrations.find(i => i.name === 'Voice Capture');

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Mic className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Voice</h2>
      </div>

      {loading && !voiceStats ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Pipecat (Conversational)</span>
            {pipecatIntegration ? (
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${pipecatIntegration.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-xs text-muted-foreground">{pipecatIntegration.detail ?? pipecatIntegration.status}</span>
              </div>
            ) : (
              <Badge variant="secondary" className="text-xs">Not configured</Badge>
            )}
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Voice Capture (iOS Shortcut)</span>
            {voiceCaptureIntegration ? (
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${voiceCaptureIntegration.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-xs text-muted-foreground">{voiceCaptureIntegration.detail ?? voiceCaptureIntegration.status}</span>
              </div>
            ) : (
              <Badge variant="default" className="text-xs">Active</Badge>
            )}
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total Sessions</span>
            <span className="font-mono text-xs">{voiceStats?.totalSessions ?? '\u2014'}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Active Sessions</span>
            <span className={`font-mono text-xs ${(voiceStats?.activeSessions ?? 0) > 0 ? 'text-blue-600 dark:text-blue-400' : ''}`}>
              {voiceStats?.activeSessions ?? 0}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
