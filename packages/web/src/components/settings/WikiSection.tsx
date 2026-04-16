import { BookOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Skill, IntegrationStatus } from '@/lib/types';
import { describeCron } from './utils';

export interface WikiSectionProps {
  skills: Skill[];
  integrations: IntegrationStatus[];
  wikiStats: { pageCount: number; lastLintRun: string | null; lastSync: string | null } | null;
  loading: boolean;
}

export function WikiSection({ skills, integrations, wikiStats, loading }: WikiSectionProps) {
  // Wiki-related skills for schedule display
  const wikiLintSkill = skills.find(s => s.name === 'wiki-lint');
  const wikiIngestSkill = skills.find(s => s.name === 'wiki-ingest' || s.name === 'wiki-synthesis');
  const giteaIntegration = integrations.find(i => i.name === 'Gitea');
  const giteaUrl = giteaIntegration?.url;
  const giteaConfigured = giteaIntegration?.status === 'connected';

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Wiki</h2>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Gitea Repo</span>
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${giteaConfigured ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="font-mono text-xs text-muted-foreground truncate max-w-[250px]">
                {giteaUrl ?? 'Not configured'}
              </span>
            </div>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Page Count</span>
            <span className="font-mono text-xs">{wikiStats?.pageCount ?? '\u2014'}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Last Sync</span>
            <span className="text-xs text-muted-foreground">
              {wikiStats?.lastSync ? new Date(wikiStats.lastSync).toLocaleString() : '\u2014'}
            </span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Lint Schedule</span>
            <span className="font-mono text-xs">
              {wikiLintSkill?.schedule
                ? `${wikiLintSkill.schedule}${describeCron(wikiLintSkill.schedule) ? ` (${describeCron(wikiLintSkill.schedule)})` : ''}`
                : '\u2014'}
            </span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Last Lint</span>
            <span className="text-xs text-muted-foreground">
              {wikiStats?.lastLintRun ? new Date(wikiStats.lastLintRun).toLocaleString() : '\u2014'}
            </span>
          </div>
          {wikiIngestSkill && (
            <div className="px-4 py-3 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Auto-ingest</span>
              <Badge variant={wikiIngestSkill.schedule ? 'default' : 'secondary'} className="text-xs">
                {wikiIngestSkill.schedule ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
