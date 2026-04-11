import {
  FileText,
  Zap,
  GitBranch,
  Users,
  BookOpenText,
  Terminal,
  Server,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn, relativeTime } from '@/lib/utils'
import type { ActivityFeedItem as ActivityFeedItemType } from '@/lib/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; label: string; color: string }
> = {
  capture: { icon: FileText, label: 'Capture', color: 'text-blue-600 dark:text-blue-400' },
  skill: { icon: Zap, label: 'Skill', color: 'text-amber-600 dark:text-amber-400' },
  pipeline: { icon: GitBranch, label: 'Pipeline', color: 'text-green-600 dark:text-green-400' },
  entity: { icon: Users, label: 'Entity', color: 'text-purple-600 dark:text-purple-400' },
  wiki: { icon: BookOpenText, label: 'Wiki', color: 'text-teal-600 dark:text-teal-400' },
  mcp: { icon: Terminal, label: 'MCP', color: 'text-pink-600 dark:text-pink-400' },
  system: { icon: Server, label: 'System', color: 'text-gray-600 dark:text-gray-400' },
}

const VIEW_BADGE_COLORS: Record<string, string> = {
  career: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300',
  personal: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300',
  technical: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300',
  'work-internal': 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300',
  client: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ActivityFeedItemProps {
  item: ActivityFeedItemType
  onClick?: (item: ActivityFeedItemType) => void
  isNew?: boolean
}

export default function ActivityFeedItem({ item, onClick, isNew }: ActivityFeedItemProps) {
  const config = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.system
  const Icon = config.icon
  const viewColor = item.view ? VIEW_BADGE_COLORS[item.view] : undefined

  return (
    <Card
      className={cn(
        'transition-colors',
        onClick && 'cursor-pointer hover:border-primary/50',
        isNew && 'border-l-2 border-l-primary',
      )}
      onClick={() => onClick?.(item)}
    >
      <CardContent className="flex items-start gap-3 p-3">
        {/* Type icon */}
        <div className={cn('mt-0.5 shrink-0', config.color)}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Summary */}
          <p className="text-sm leading-snug line-clamp-2">{item.summary}</p>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {config.label}
              {item.subtype ? ` / ${item.subtype}` : ''}
            </Badge>

            {item.view && viewColor && (
              <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 border', viewColor)}>
                {item.view}
              </Badge>
            )}

            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {relativeTime(item.timestamp)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
