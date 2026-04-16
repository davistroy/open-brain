import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { skillsApi, triggersApi, settingsApi, configApi, voiceSessionApi, wikiApi } from '@/lib/api';
import type { Skill, Trigger, AutonomyLevel, AIRoutingResponse, IntegrationStatus, WikiLintReport } from '@/lib/types';
import {
  VersionUptimeSection,
  ServiceHealthSection,
  TriggersSection,
  AutonomyLevelSection,
  EmailAllowlistSection,
  AIRoutingSection,
  VoiceSection,
  WikiSection,
  EmailConfigSection,
  IntegrationsSection,
  DangerZoneSection,
} from '@/components/settings';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HealthResponse {
  status: string;
  version?: string;
  uptime_s?: number;
  services?: Record<string, { status: 'up' | 'down' | 'degraded'; latency_ms?: number; models_available?: string[] }>;
}

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Settings() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(true);
  const [triggersError, setTriggersError] = useState<string | null>(null);

  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>('observe');
  const [autonomyLoading, setAutonomyLoading] = useState(true);
  const [autonomyError, setAutonomyError] = useState<string | null>(null);

  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [allowlistLoading, setAllowlistLoading] = useState(true);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);

  const [aiRouting, setAiRouting] = useState<AIRoutingResponse | null>(null);
  const [aiRoutingLoading, setAiRoutingLoading] = useState(true);
  const [aiRoutingError, setAiRoutingError] = useState<string | null>(null);

  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);

  const [voiceStats, setVoiceStats] = useState<{ totalSessions: number; activeSessions: number } | null>(null);
  const [voiceStatsLoading, setVoiceStatsLoading] = useState(true);

  const [wikiStats, setWikiStats] = useState<{ pageCount: number; lastLintRun: string | null; lastSync: string | null } | null>(null);
  const [wikiStatsLoading, setWikiStatsLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);

  // ─── Data loaders ───────────────────────────────────────────────────────────

  const loadHealth = useCallback(async () => {
    setHealthError(null);
    try {
      const data = await apiFetch<HealthResponse>('/api/v1/health');
      setHealth(data);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Could not reach Core API. Is it running?');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const res = await skillsApi.list();
      setSkills(res.data);
    } catch {
      // Skills are only used for WikiSection display — non-critical
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const loadTriggers = useCallback(async () => {
    setTriggersError(null);
    try {
      const res = await triggersApi.list();
      setTriggers(res.data);
    } catch (err) {
      setTriggersError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setTriggersLoading(false);
    }
  }, []);

  const loadAutonomy = useCallback(async () => {
    setAutonomyError(null);
    try {
      const res = await settingsApi.get<string>('autonomy_level');
      setAutonomyLevel(res.value as AutonomyLevel);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        setAutonomyLevel('observe');
      } else {
        setAutonomyError(err instanceof Error ? err.message : 'Failed to load autonomy level');
      }
    } finally {
      setAutonomyLoading(false);
    }
  }, []);

  const loadAllowlist = useCallback(async () => {
    setAllowlistError(null);
    try {
      const res = await settingsApi.get<string[]>('email_allowlist');
      setAllowlist(res.value);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        setAllowlist([]);
      } else {
        setAllowlistError(err instanceof Error ? err.message : 'Failed to load allowlist');
      }
    } finally {
      setAllowlistLoading(false);
    }
  }, []);

  const loadAiRouting = useCallback(async () => {
    setAiRoutingError(null);
    try {
      const res = await configApi.aiRouting();
      setAiRouting(res);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        setAiRouting(null);
      } else {
        setAiRoutingError(err instanceof Error ? err.message : 'Failed to load AI routing');
      }
    } finally {
      setAiRoutingLoading(false);
    }
  }, []);

  const loadIntegrations = useCallback(async () => {
    setIntegrationsError(null);
    try {
      const res = await configApi.integrations();
      setIntegrations(res.integrations);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        setIntegrations([]);
      } else {
        setIntegrationsError(err instanceof Error ? err.message : 'Failed to load integrations');
      }
    } finally {
      setIntegrationsLoading(false);
    }
  }, []);

  const loadVoiceStats = useCallback(async () => {
    try {
      const [listRes, activeRes] = await Promise.allSettled([
        voiceSessionApi.list({ limit: 1 }),
        voiceSessionApi.active(),
      ]);
      setVoiceStats({
        totalSessions: listRes.status === 'fulfilled' ? listRes.value.total : 0,
        activeSessions: activeRes.status === 'fulfilled' ? activeRes.value.sessions.length : 0,
      });
    } catch {
      setVoiceStats({ totalSessions: 0, activeSessions: 0 });
    } finally {
      setVoiceStatsLoading(false);
    }
  }, []);

  const loadWikiStats = useCallback(async () => {
    try {
      const [pagesRes, lintRes, changesRes] = await Promise.allSettled([
        wikiApi.pages(),
        wikiApi.lintReport(),
        wikiApi.recentChanges(1),
      ]);
      setWikiStats({
        pageCount: pagesRes.status === 'fulfilled' ? pagesRes.value.length : 0,
        lastLintRun: lintRes.status === 'fulfilled' ? (lintRes.value as WikiLintReport).last_run ?? null : null,
        lastSync: changesRes.status === 'fulfilled' && changesRes.value.length > 0
          ? changesRes.value[0].date
          : null,
      });
    } catch {
      setWikiStats({ pageCount: 0, lastLintRun: null, lastSync: null });
    } finally {
      setWikiStatsLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.allSettled([loadHealth(), loadSkills(), loadTriggers(), loadAutonomy(), loadAllowlist(), loadAiRouting(), loadIntegrations(), loadVoiceStats(), loadWikiStats()]);
  }, [loadHealth, loadSkills, loadTriggers, loadAutonomy, loadAllowlist, loadAiRouting, loadIntegrations, loadVoiceStats, loadWikiStats]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async function handleRefresh() {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }

  async function handleAddTrigger(name: string, queryText: string) {
    await triggersApi.create(name, queryText);
    await loadTriggers();
  }

  async function handleDeleteTrigger(id: string) {
    await triggersApi.delete(id);
    await loadTriggers();
  }

  async function handleAutonomyChange(level: AutonomyLevel) {
    await settingsApi.put('autonomy_level', level);
    setAutonomyLevel(level);
  }

  async function handleAddAllowlistEntry(entry: string) {
    const updated = [...allowlist, entry];
    await settingsApi.put('email_allowlist', updated);
    setAllowlist(updated);
  }

  async function handleRemoveAllowlistEntry(entry: string) {
    const updated = allowlist.filter((e) => e !== entry);
    await settingsApi.put('email_allowlist', updated);
    setAllowlist(updated);
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <VersionUptimeSection version={health?.version} uptime_s={health?.uptime_s} loading={healthLoading} error={healthError} />
      <Separator />
      <ServiceHealthSection services={health?.services} loading={healthLoading} />
      <Separator />
      <TriggersSection triggers={triggers} loading={triggersLoading} error={triggersError} onAdd={handleAddTrigger} onDelete={handleDeleteTrigger} />
      <Separator />
      <AutonomyLevelSection level={autonomyLevel} loading={autonomyLoading} error={autonomyError} onChange={handleAutonomyChange} />
      <Separator />
      <EmailAllowlistSection entries={allowlist} loading={allowlistLoading} error={allowlistError} onAdd={handleAddAllowlistEntry} onRemove={handleRemoveAllowlistEntry} />
      <Separator />
      <AIRoutingSection routing={aiRouting} loading={aiRoutingLoading} error={aiRoutingError} />
      <Separator />
      <VoiceSection integrations={integrations} voiceStats={voiceStats} loading={voiceStatsLoading} />
      <Separator />
      <WikiSection skills={skills} integrations={integrations} wikiStats={wikiStats} loading={skillsLoading || wikiStatsLoading} />
      <Separator />
      <EmailConfigSection integrations={integrations} loading={integrationsLoading} />
      <Separator />
      <IntegrationsSection integrations={integrations} loading={integrationsLoading} error={integrationsError} />
      <Separator />
      <DangerZoneSection />
    </div>
  );
}
