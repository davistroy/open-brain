import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, CheckCircle, XCircle, RefreshCw, AlertCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { betsApi } from '@/lib/api';
import type { Bet } from '@/lib/types';

// ─── Session types (not in shared types — Board-only) ────────────────────────

type SessionType = 'quick_check' | 'quarterly';
type SessionStatus = 'active' | 'complete' | 'paused';

interface SessionState {
  turn_count: number;
  max_turns: number;
  topics_covered: string[];
  topics_remaining: string[];
  last_role: string | null;
  idle_timeout_minutes: number;
}

interface SessionMessage {
  role: 'bot' | 'user';
  board_role?: string;
  content: string;
  timestamp: string;
}

interface Session {
  id: string;
  session_type: SessionType;
  status: SessionStatus;
  state: SessionState;
  transcript: SessionMessage[];
  created_at: string;
  prompt?: string;
  board_role?: string;
}

// Actual API response shape for POST /sessions
interface SessionCreateResponse {
  session: {
    id: string;
    session_type: string;
    status: string;
    config: Record<string, unknown> | null;
    created_at: string;
  };
  first_message: string;
}

// Actual API response shape for POST /sessions/:id/respond
interface SessionRespondResponse {
  session: {
    id: string;
    status: string;
  };
  bot_message: string;
}

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  strategist: 'bg-purple-100 text-purple-800 border-purple-200',
  operator: 'bg-blue-100 text-blue-800 border-blue-200',
  contrarian: 'bg-orange-100 text-orange-800 border-orange-200',
  coach: 'bg-green-100 text-green-800 border-green-200',
  analyst: 'bg-yellow-100 text-yellow-800 border-yellow-200',
};

function RoleBadge({ role }: { role?: string }) {
  if (!role) return null;
  const cls = ROLE_COLORS[role] ?? 'bg-secondary text-secondary-foreground';
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {role}
    </span>
  );
}

function TranscriptBubble({ msg }: { msg: SessionMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
        {!isUser && msg.board_role && (
          <div className="mb-1">
            <RoleBadge role={msg.board_role} />
          </div>
        )}
        <p className="leading-relaxed">{msg.content}</p>
        <p className={`text-xs mt-1 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  );
}

function ActiveSession({
  session,
  onRespond,
  onEnd,
}: {
  session: Session;
  onRespond: (text: string) => Promise<void>;
  onEnd: () => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.transcript]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      await onRespond(text);
      setInput('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  const state = session.state;
  const pct = state.max_turns > 0 ? Math.round((state.turn_count / state.max_turns) * 100) : 0;

  return (
    <div className="rounded-lg border bg-card space-y-4 p-4">
      {/* Session meta */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="default" className="capitalize">{session.session_type.replace('_', ' ')}</Badge>
          <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">Active</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onEnd} className="text-muted-foreground text-xs">
          End session
        </Button>
      </div>

      {/* Progress */}
      <div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
          <span>Turn {state.turn_count} / {state.max_turns}</span>
          <span>{state.topics_remaining.length} topics remaining</span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
        {state.topics_covered.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Covered: {state.topics_covered.join(', ')}
          </p>
        )}
      </div>

      <Separator />

      {/* Transcript */}
      <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
        {session.transcript.map((msg, i) => (
          <TranscriptBubble key={i} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Current prompt if available */}
      {session.prompt && session.transcript.length === 0 && (
        <div className="rounded-lg bg-secondary p-3 text-sm">
          <RoleBadge role={session.board_role} />
          <p className="mt-1">{session.prompt}</p>
        </div>
      )}

      {sendError && (
        <p className="text-xs text-destructive">{sendError}</p>
      )}

      {/* Response input */}
      <form onSubmit={handleSend} className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Your response..."
          disabled={sending}
          className="flex-1"
          autoFocus
        />
        <Button type="submit" disabled={sending || !input.trim()} className="gap-2 shrink-0">
          <Send className="h-4 w-4" />
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </form>
    </div>
  );
}

const BET_STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-50 text-blue-800 border-blue-200',
  won: 'bg-green-50 text-green-800 border-green-200',
  lost: 'bg-red-50 text-red-800 border-red-200',
  expired: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground',
};

function BetRow({ bet, onResolve }: { bet: Bet; onResolve: (id: string, outcome: 'won' | 'lost' | 'cancelled') => Promise<void> }) {
  const [resolving, setResolving] = useState(false);
  const isOpen = bet.status === 'open';
  const cls = BET_STATUS_COLORS[bet.status] ?? '';

  async function resolve(outcome: 'won' | 'lost' | 'cancelled') {
    setResolving(true);
    try {
      await onResolve(bet.id, outcome);
    } finally {
      setResolving(false);
    }
  }

  const dueDateStr = bet.resolution_date ?? bet.due_date;
  const dueDateObj = dueDateStr ? new Date(dueDateStr) : null;
  const dueDate = dueDateObj
    ? dueDateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'No due date';
  const isPast = dueDateObj !== null && dueDateObj < new Date();

  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{bet.statement ?? bet.description}</p>
          {bet.rationale && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{bet.rationale}</p>
          )}
        </div>
        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium capitalize shrink-0 ${cls}`}>
          {bet.status}
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className={isPast && isOpen ? 'text-destructive font-medium' : ''}>
          {dueDate !== 'No due date' ? `Due ${dueDate}` : dueDate}{isPast && isOpen ? ' (overdue)' : ''}
        </span>
        {(bet.tags ?? []).length > 0 && (
          <span className="flex gap-1">
            {(bet.tags ?? []).map((t: string) => (
              <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
            ))}
          </span>
        )}
        {bet.resolved_at && (
          <span>Resolved {new Date(bet.resolved_at).toLocaleDateString()}</span>
        )}
      </div>

      {isOpen && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5 text-green-700 border-green-300 hover:bg-green-50" disabled={resolving} onClick={() => resolve('won')}>
            <CheckCircle className="h-3.5 w-3.5" />
            Won
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10" disabled={resolving} onClick={() => resolve('lost')}>
            <XCircle className="h-3.5 w-3.5" />
            Lost
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={resolving} onClick={() => resolve('cancelled')}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Board() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [bets, setBets] = useState<Bet[]>([]);
  const [betsLoading, setBetsLoading] = useState(true);
  const [betsError, setBetsError] = useState<string | null>(null);
  const [betFilter, setBetFilter] = useState<'all' | 'open'>('all');

  // Add bet form
  const [addingBet, setAddingBet] = useState(false);
  const [betStatement, setBetStatement] = useState('');
  const [betConfidence, setBetConfidence] = useState('0.7');
  const [betDue, setBetDue] = useState('');
  const [betSubmitting, setBetSubmitting] = useState(false);
  const [betError, setBetError] = useState<string | null>(null);

  const loadBets = useCallback(async () => {
    setBetsLoading(true);
    setBetsError(null);
    try {
      const params = betFilter === 'open' ? { status: 'open' } : undefined;
      const res = await betsApi.list(params);
      setBets(res.data);
    } catch (err) {
      setBetsError(err instanceof Error ? err.message : 'Failed to load bets');
    } finally {
      setBetsLoading(false);
    }
  }, [betFilter]);

  useEffect(() => {
    loadBets();
  }, [loadBets]);

  async function startSession(session_type: SessionType) {
    setSessionLoading(true);
    setSessionError(null);
    try {
      // Map UI session type to API type field
      const apiType = session_type === 'quick_check' ? 'governance' : 'review';
      const res = await apiPost<SessionCreateResponse>('/api/v1/sessions', { type: apiType });
      // Build initial transcript from first_message
      const transcript: SessionMessage[] = res.first_message
        ? [{ role: 'bot', content: res.first_message, timestamp: new Date().toISOString() }]
        : [];
      setSession({
        id: res.session.id,
        session_type: (res.session.session_type as SessionType) ?? session_type,
        status: res.session.status as SessionStatus,
        state: { turn_count: 0, max_turns: 20, topics_covered: [], topics_remaining: [], last_role: null, idle_timeout_minutes: 30 },
        transcript,
        created_at: res.session.created_at ?? new Date().toISOString(),
      });
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setSessionLoading(false);
    }
  }

  async function handleRespond(text: string) {
    if (!session) return;
    // Optimistically add user message
    const userMsg: SessionMessage = { role: 'user', content: text, timestamp: new Date().toISOString() };
    setSession((s) => s ? { ...s, transcript: [...s.transcript, userMsg] } : s);

    const res = await apiPost<SessionRespondResponse>(`/api/v1/sessions/${session.id}/respond`, { message: text });

    const botMsg: SessionMessage | null = res.bot_message
      ? { role: 'bot', content: res.bot_message, timestamp: new Date().toISOString() }
      : null;

    setSession((s) => {
      if (!s) return s;
      const newTranscript = botMsg ? [...s.transcript, botMsg] : s.transcript;
      const turn_count = Math.floor(newTranscript.filter(m => m.role === 'user').length);
      return {
        ...s,
        status: res.session.status as SessionStatus,
        state: { ...s.state, turn_count },
        transcript: newTranscript,
      };
    });
  }

  async function handleResolveBet(id: string, outcome: 'won' | 'lost' | 'cancelled') {
    await betsApi.resolve(id, outcome);
    await loadBets();
  }

  async function handleAddBet(e: React.FormEvent) {
    e.preventDefault();
    const stmt = betStatement.trim();
    const confidence = parseFloat(betConfidence);
    if (!stmt || isNaN(confidence) || confidence < 0 || confidence > 1) return;
    setBetSubmitting(true);
    setBetError(null);
    try {
      await betsApi.create({
        statement: stmt,
        confidence,
        due_date: betDue || undefined,
      });
      setBetStatement('');
      setBetConfidence('0.7');
      setBetDue('');
      setAddingBet(false);
      await loadBets();
    } catch (err) {
      setBetError(err instanceof Error ? err.message : 'Failed to add bet');
    } finally {
      setBetSubmitting(false);
    }
  }

  const filteredBets = betFilter === 'open' ? bets.filter((b) => b.status === 'open') : bets;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Board</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Governance sessions and bet tracking</p>
      </div>

      {/* Governance Session */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Governance Session</h2>

        {sessionError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {sessionError}
          </div>
        )}

        {!session ? (
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              onClick={() => startSession('quick_check')}
              disabled={sessionLoading}
              className="gap-2"
            >
              {sessionLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
              Start Quick Check
            </Button>
            <Button
              variant="outline"
              onClick={() => startSession('quarterly')}
              disabled={sessionLoading}
            >
              Start Quarterly Review
            </Button>
          </div>
        ) : (
          <ActiveSession
            session={session}
            onRespond={handleRespond}
            onEnd={() => setSession(null)}
          />
        )}
      </section>

      <Separator />

      {/* Bet Tracking */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Bets</h2>
          <div className="flex gap-2">
            <div className="flex rounded-md border text-sm overflow-hidden">
              {(['all', 'open'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setBetFilter(f)}
                  className={`px-3 py-1.5 capitalize transition-colors ${betFilter === f ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                >
                  {f}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={loadBets} disabled={betsLoading} className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${betsLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" onClick={() => setAddingBet((v) => !v)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Bet
            </Button>
          </div>
        </div>

        {/* Add bet form */}
        {addingBet && (
          <form onSubmit={handleAddBet} className="rounded-lg border bg-card p-4 space-y-3">
            <h3 className="text-sm font-medium">New Bet</h3>
            <Input
              value={betStatement}
              onChange={(e) => setBetStatement(e.target.value)}
              placeholder="Statement (e.g. QSR proposal accepted by March 15)"
              required
            />
            <div className="flex gap-3">
              <div className="flex gap-2 items-center">
                <label className="text-sm text-muted-foreground whitespace-nowrap">Confidence (0–1):</label>
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={betConfidence}
                  onChange={(e) => setBetConfidence(e.target.value)}
                  required
                  className="w-24"
                />
              </div>
              <div className="flex gap-2 items-center">
                <label className="text-sm text-muted-foreground whitespace-nowrap">Due date:</label>
                <Input
                  type="date"
                  value={betDue}
                  onChange={(e) => setBetDue(e.target.value)}
                  className="w-auto"
                />
              </div>
            </div>
            {betError && <p className="text-xs text-destructive">{betError}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={betSubmitting || !betStatement.trim()}>
                {betSubmitting ? 'Adding...' : 'Add'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAddingBet(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {betsError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {betsError}
          </div>
        )}

        {betsLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-secondary" />
            ))}
          </div>
        ) : filteredBets.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            <p className="text-sm">No {betFilter === 'open' ? 'open ' : ''}bets yet.</p>
            <p className="text-xs mt-1">Bets are tracked commitments from governance sessions.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredBets.map((bet) => (
              <BetRow key={bet.id} bet={bet} onResolve={handleResolveBet} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
