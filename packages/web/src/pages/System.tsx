import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  Activity,
  Zap,
  GitBranch,
  Server,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { systemHealthApi, skillsApi, adminApi, mcpActivityApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  Skill,
  SystemHealthSnapshot,
  McpActivityEntry,
  InfrastructureData,
  PipelineFlowEntry,
} from '@/lib/types';
import {
  QueuesTab,
  SkillsTab,
  FlowsTab,
  InfrastructureTab,
  McpActivityTab,
  OverviewStrip,
} from '@/components/system';

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = 'queues' | 'flows' | 'skills' | 'infrastructure' | 'mcp';

const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'queues', label: 'Queues', icon: Activity },
  { key: 'flows', label: 'Flows', icon: GitBranch },
  { key: 'skills', label: 'Skills', icon: Zap },
  { key: 'infrastructure', label: 'Infrastructure', icon: Server },
  { key: 'mcp', label: 'MCP Activity', icon: Wrench },
];

const MCP_PAGE_SIZE = 30;

// ─── Main System Page ───────────────────────────────────────────────────────

export default function System() {
  const [activeTab, setActiveTab] = useState<Tab>('queues');
  const [refreshing, setRefreshing] = useState(false);

  // Queues state
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [queuesLoading, setQueuesLoading] = useState(true);
  const [queuesError, setQueuesError] = useState<string | null>(null);

  // Skills state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  // Flows state
  const [flows, setFlows] = useState<PipelineFlowEntry[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [flowsError, setFlowsError] = useState<string | null>(null);

  // Infrastructure state
  const [infraData, setInfraData] = useState<InfrastructureData | null>(null);
  const [infraLoading, setInfraLoading] = useState(true);
  const [infraError, setInfraError] = useState<string | null>(null);

  // MCP activity state
  const [mcpEntries, setMcpEntries] = useState<McpActivityEntry[]>([]);
  const [mcpTotal, setMcpTotal] = useState(0);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpError, setMcpError] = useState<string | null>(null);

  // ── Data loaders ──

  const loadQueues = useCallback(async () => {
    setQueuesError(null);
    try {
      const data = await systemHealthApi.fullSnapshot();
      setSnapshot(data);
    } catch (err) {
      setQueuesError(err instanceof Error ? err.message : 'Failed to load system health');
    } finally {
      setQueuesLoading(false);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    setSkillsError(null);
    try {
      const res = await skillsApi.list();
      setSkills(res.data);
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const loadFlows = useCallback(async () => {
    setFlowsError(null);
    try {
      const res = await systemHealthApi.flows(30);
      setFlows(res.flows);
    } catch (err) {
      setFlowsError(err instanceof Error ? err.message : 'Failed to load pipeline flows');
    } finally {
      setFlowsLoading(false);
    }
  }, []);

  const loadInfrastructure = useCallback(async () => {
    setInfraError(null);
    try {
      const data = await systemHealthApi.infrastructure();
      setInfraData(data);
    } catch (err) {
      setInfraError(err instanceof Error ? err.message : 'Failed to load infrastructure data');
    } finally {
      setInfraLoading(false);
    }
  }, []);

  const loadMcpActivity = useCallback(async (append = false) => {
    setMcpError(null);
    setMcpLoading(true);
    try {
      const offset = append ? mcpEntries.length : 0;
      const res = await mcpActivityApi.list({ limit: MCP_PAGE_SIZE, offset });
      if (append) {
        setMcpEntries((prev) => [...prev, ...res.items]);
      } else {
        setMcpEntries(res.items);
      }
      setMcpTotal(res.total);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to load MCP activity');
    } finally {
      setMcpLoading(false);
    }
  }, [mcpEntries.length]);

  // ── Initial load ──

  useEffect(() => {
    loadQueues();
    loadSkills();
    loadFlows();
    loadInfrastructure();
    loadMcpActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refresh ──

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.allSettled([
      loadQueues(),
      loadSkills(),
      loadFlows(),
      loadInfrastructure(),
      loadMcpActivity(),
    ]);
    setRefreshing(false);
  }

  // ── Queue actions ──

  async function handleClearFailed(queueName: string) {
    await adminApi.clearQueue(queueName, 'failed');
    await loadQueues();
  }

  // ── Skill actions ──

  async function handleTriggerSkill(name: string) {
    await skillsApi.trigger(name);
  }

  async function handleScheduleUpdate(name: string, schedule: string) {
    await skillsApi.updateSchedule(name, schedule);
    await loadSkills();
  }

  // ── MCP load more ──

  function handleLoadMoreMcp() {
    loadMcpActivity(true);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System</h1>
          <p className="text-sm text-muted-foreground">
            Queues, pipeline flows, skills, infrastructure, and MCP activity
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-4 w-4 mr-1', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Overview strip from snapshot */}
      {snapshot && <OverviewStrip snapshot={snapshot} />}

      <Separator />

      {/* Tab navigation */}
      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'queues' && (
        <QueuesTab
          queues={snapshot?.queues ?? []}
          loading={queuesLoading}
          error={queuesError}
          onClearFailed={handleClearFailed}
        />
      )}

      {activeTab === 'flows' && (
        <FlowsTab
          flows={flows}
          loading={flowsLoading}
          error={flowsError}
        />
      )}

      {activeTab === 'skills' && (
        <SkillsTab
          skills={skills}
          skillRuns={snapshot?.skill_last_runs ?? []}
          loading={skillsLoading}
          error={skillsError}
          onTrigger={handleTriggerSkill}
          onScheduleUpdate={handleScheduleUpdate}
        />
      )}

      {activeTab === 'infrastructure' && (
        <InfrastructureTab
          data={infraData}
          loading={infraLoading}
          error={infraError}
        />
      )}

      {activeTab === 'mcp' && (
        <McpActivityTab
          entries={mcpEntries}
          total={mcpTotal}
          loading={mcpLoading}
          error={mcpError}
          onLoadMore={handleLoadMoreMcp}
          hasMore={mcpEntries.length < mcpTotal}
        />
      )}
    </div>
  );
}
