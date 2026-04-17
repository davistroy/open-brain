import { useEffect, useState, useCallback } from 'react'
import { FileText, AlertCircle, Mail } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { emailApi } from '@/lib/api'
import type { EmailDraft } from '@/lib/types'
import { cn, formatRelativeTime } from '@/lib/utils'

interface Props {
  /** Called when the user clicks a draft row — parent opens the compose drawer. */
  onOpenDraft: (draftId: string) => void
  /** Status filter. 'all' omits the filter entirely. Default: 'draft'. */
  statusFilter?: 'draft' | 'sent' | 'failed' | 'all'
  /** Bump this to trigger a refetch without remounting. */
  refreshKey?: number
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  approved: 'bg-blue-100 text-blue-800 border-blue-200',
  sent: 'bg-green-100 text-green-800 border-green-200',
  rejected: 'bg-gray-100 text-gray-600 border-gray-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
}

/**
 * Compact list view of email drafts. Click any row to open the compose drawer
 * in edit mode. Used by the Email page's Drafts tab.
 */
export function EmailDraftsList({
  onOpenDraft,
  statusFilter = 'draft',
  refreshKey = 0,
}: Props) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await emailApi.list({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 50,
      })
      setDrafts(result.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  if (loading) {
    return (
      <div className="space-y-2" aria-label="Loading drafts">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-md bg-secondary" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    )
  }

  if (drafts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        <Mail className="h-10 w-10 mx-auto mb-3 opacity-50" />
        <p className="text-sm">No drafts yet. Click Compose to start one.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {drafts.map((draft) => (
        <Card
          key={draft.id}
          className="hover:border-primary/50 transition-colors cursor-pointer"
          role="button"
          tabIndex={0}
          onClick={() => onOpenDraft(draft.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpenDraft(draft.id)
            }
          }}
        >
          <CardContent className="p-3">
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-sm truncate">
                    {draft.subject || '(no subject)'}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn('text-xs border shrink-0', STATUS_STYLES[draft.status])}
                  >
                    {draft.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">To: {draft.to_address || '(no recipient)'}</span>
                  <span className="ml-auto shrink-0">
                    {formatRelativeTime(draft.updated_at ?? draft.created_at)}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default EmailDraftsList
