'use client';

/**
 * SystemTabs — 5-tab client shell for the System page (M3, work item 6.4).
 *
 * Manages tab selection state. Each tab receives pre-fetched RSC data as props.
 *
 * Tabs:
 *   1. Overview     — health strip + summary cards
 *   2. Queues       — BullMQ queue status + clear action
 *   3. Skills       — skill list + trigger + schedule
 *   4. Flows        — pipeline flow monitor
 *   5. MCP Activity — paginated MCP activity log
 */

import { useState } from 'react';
import { OverviewTab } from './OverviewTab';
import { QueuesTab } from './QueuesTab';
import { SkillsTab } from './SkillsTab';
import { FlowsTab } from './FlowsTab';
import { McpActivityTab } from './McpActivityTab';
import type {
  SystemHealthSnapshot,
  SkillRecord,
  PipelineFlowEntry,
  ListEnvelope,
  McpActivityEntry,
} from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'queues' | 'skills' | 'flows' | 'mcp';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'queues', label: 'Queues' },
  { id: 'skills', label: 'Skills' },
  { id: 'flows', label: 'Flows' },
  { id: 'mcp', label: 'MCP Activity' },
];

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface SystemTabsProps {
  snapshot: SystemHealthSnapshot;
  skills: SkillRecord[];
  flows: PipelineFlowEntry[];
  mcpActivity: ListEnvelope<McpActivityEntry>;
}

export function SystemTabs({
  snapshot,
  skills,
  flows,
  mcpActivity,
}: SystemTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  return (
    <div>
      {/* Tab bar */}
      <div
        className="flex border-b border-cloud-medium mb-[24px]"
        role="tablist"
        aria-label="System sections"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'inline-flex items-center gap-2 px-[18px] py-[10px] -mb-px',
                'bg-transparent border-none cursor-pointer',
                'font-body text-[13px] transition-colors duration-[120ms]',
                isActive
                  ? 'border-b-2 border-book-cloth text-text-heading font-normal'
                  : 'border-b-2 border-transparent text-text-body-secondary font-light hover:text-text-heading',
              ].join(' ')}
              style={{ outline: 'none' }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {activeTab === 'overview' && <OverviewTab snapshot={snapshot} />}
      {activeTab === 'queues' && <QueuesTab queues={snapshot.queues} />}
      {activeTab === 'skills' && <SkillsTab skills={skills} />}
      {activeTab === 'flows' && <FlowsTab flows={flows} />}
      {activeTab === 'mcp' && <McpActivityTab initialData={mcpActivity} />}
    </div>
  );
}
