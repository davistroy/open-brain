import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  Mic,
  ChevronLeft,
  MessageSquare,
  Clock,
  FileText,
  AlertCircle,
  Upload,
  Hash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn, formatDateTime, relativeTime, truncate } from '@/lib/utils';
import { voiceSessionApi, capturesApi } from '@/lib/api';
import TranscriptViewer from '@/components/TranscriptViewer';
import CaptureCard from '@/components/CaptureCard';
import type { VoiceSession, Capture } from '@/lib/types';

// ─── Helper functions ──────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === 0) return '--';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ─── Active Session Indicator ──────────────────────────────────────────────

function ActiveSessionBanner({ session }: { session: VoiceSession }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(session.started_at).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session.started_at]);

  return (
    <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 p-4">
      <div className="flex items-center gap-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium text-green-800 dark:text-green-200">
            Active voice conversation
          </p>
          <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">
            {formatDuration(elapsed)} elapsed &middot; {session.turn_count} turn{session.turn_count !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Session Row ───────────────────────────────────────────────────────────

interface SessionRowProps {
  session: VoiceSession;
  onClick: () => void;
}

function SessionRow({ session, onClick }: SessionRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">
              {formatDateTime(session.started_at)}
            </span>
            <Badge variant="outline" className="text-xs gap-1 font-mono">
              <Hash className="h-3 w-3" />
              {session.session_key.slice(0, 8)}
            </Badge>
            <Badge variant="outline" className="text-xs gap-1">
              <MessageSquare className="h-3 w-3" />
              {session.turn_count} turn{session.turn_count !== 1 ? 's' : ''}
            </Badge>
            {session.duration_s !== null && (
              <Badge variant="outline" className="text-xs gap-1">
                <Clock className="h-3 w-3" />
                {formatDuration(session.duration_s)}
              </Badge>
            )}
            {session.captures_created > 0 && (
              <Badge variant="secondary" className="text-xs gap-1">
                <FileText className="h-3 w-3" />
                {session.captures_created} capture{session.captures_created !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          {session.summary ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {truncate(session.summary, 200)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">No summary</p>
          )}
        </div>
        <span className="text-xs text-muted-foreground shrink-0 mt-1">
          {relativeTime(session.started_at)}
        </span>
      </div>
    </button>
  );
}

// ─── Session Detail ────────────────────────────────────────────────────────

interface SessionDetailProps {
  session: VoiceSession;
  onBack: () => void;
}

function SessionDetail({ session, onBack }: SessionDetailProps) {
  const [linkedCaptures, setLinkedCaptures] = useState<Capture[]>([]);
  const [loadingCaptures, setLoadingCaptures] = useState(false);

  useEffect(() => {
    if (session.capture_ids.length === 0) return;
    setLoadingCaptures(true);
    Promise.all(session.capture_ids.map((id) => capturesApi.get(id).catch(() => null)))
      .then((results) => {
        setLinkedCaptures(results.filter((c): c is Capture => c !== null));
      })
      .finally(() => setLoadingCaptures(false));
  }, [session.capture_ids]);

  return (
    <div className="space-y-4">
      {/* Header with back button */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <div>
          <h2 className="text-lg font-semibold">
            {formatDateTime(session.started_at)}
          </h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{session.session_key.slice(0, 8)}</span>
            <span>&middot;</span>
            <span>{formatDuration(session.duration_s)}</span>
            <span>&middot;</span>
            <span>{session.turn_count} turn{session.turn_count !== 1 ? 's' : ''}</span>
            {session.captures_created > 0 && (
              <>
                <span>&middot;</span>
                <span>{session.captures_created} capture{session.captures_created !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      {session.summary && (
        <Card>
          <CardContent className="pt-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Summary
            </h3>
            <p className="text-sm">{session.summary}</p>
          </CardContent>
        </Card>
      )}

      <div className={cn(
        'gap-4',
        session.capture_ids.length > 0 ? 'grid grid-cols-1 lg:grid-cols-[1fr_280px]' : '',
      )}>
        {/* Transcript */}
        <Card>
          <CardContent className="pt-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Transcript
            </h3>
            <TranscriptViewer
              turns={session.transcript}
              className="max-h-[600px] pr-2"
            />
          </CardContent>
        </Card>

        {/* Linked captures sidebar */}
        {session.capture_ids.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Linked Captures
            </h3>
            {loadingCaptures ? (
              <div className="space-y-2">
                {[...Array(Math.min(session.capture_ids.length, 3))].map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary" />
                ))}
              </div>
            ) : linkedCaptures.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No linked captures found.
              </p>
            ) : (
              linkedCaptures.map((c) => (
                <CaptureCard key={c.id} capture={c} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export default function VoiceConversations() {
  const [sessions, setSessions] = useState<VoiceSession[]>([]);
  const [activeSessions, setActiveSessions] = useState<VoiceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<VoiceSession | null>(null);
  const [showUploadInfo, setShowUploadInfo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessionsRes, activeRes] = await Promise.allSettled([
        voiceSessionApi.list({ limit: 50 }),
        voiceSessionApi.active(),
      ]);

      if (sessionsRes.status === 'fulfilled') {
        setSessions(sessionsRes.value.items ?? []);
      } else {
        // API may not exist yet — show empty state gracefully
        setSessions([]);
      }

      if (activeRes.status === 'fulfilled') {
        setActiveSessions(activeRes.value.sessions ?? []);
      } else {
        setActiveSessions([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load voice sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll for active sessions every 10 seconds
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await voiceSessionApi.active();
        setActiveSessions(res.sessions ?? []);
      } catch {
        // Silently ignore polling errors
      }
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  // ─── Detail view ───────────────────────────────────────────────────────
  if (selectedSession) {
    return (
      <div className="space-y-6">
        <SessionDetail
          session={selectedSession}
          onBack={() => setSelectedSession(null)}
        />
      </div>
    );
  }

  // ─── List view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Voice Conversations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Interactive voice conversations with your brain via Pipecat.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowUploadInfo((v) => !v)}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            Voice Memo
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Voice memo upload info panel */}
      {showUploadInfo && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Mic className="h-4 w-4" />
                Record Voice Memo
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setShowUploadInfo(false)}>
                Close
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Use the iOS Shortcut on your iPhone or Apple Watch to submit voice memos directly to
              the brain. Memos are transcribed, classified, and ingested automatically.
            </p>
            <div className="rounded-lg border bg-secondary/50 p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">How to connect:</p>
              <p>
                <strong>Pipecat (interactive):</strong> Use the iOS Shortcut to connect via WebSocket
                to <code className="bg-secondary px-1 rounded">ws://brain.troy-davis.com:8765</code> for
                a back-and-forth voice conversation with your brain.
              </p>
              <p>
                <strong>One-shot (fallback):</strong> If the Pipecat service is unavailable, the
                Shortcut falls back to recording audio and uploading via HTTP POST to the voice-capture
                endpoint.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open('/voice-upload', '_self')}
              className="gap-2"
            >
              <Upload className="h-4 w-4" />
              Open Legacy Upload
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Active session indicator */}
      {activeSessions.map((s) => (
        <ActiveSessionBanner key={s.id} session={s} />
      ))}

      <Separator />

      {/* Session list */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-secondary" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          <Mic className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No voice conversations yet.</p>
          <p className="text-xs mt-1">
            Start a voice conversation using the iOS Shortcut or Pipecat WebSocket endpoint.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onClick={() => setSelectedSession(s)}
            />
          ))}
        </div>
      )}

      {/* Footer info */}
      <div className="rounded-lg border bg-secondary/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground text-sm">How it works</p>
        <p>
          Voice conversations use Pipecat with Deepgram STT for real-time speech-to-text and
          Claude for responses. Captures are automatically extracted from conversation context
          and ingested into the brain pipeline.
        </p>
      </div>
    </div>
  );
}
