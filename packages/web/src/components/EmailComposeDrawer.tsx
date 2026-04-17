import { useState, useEffect, useCallback } from 'react'
import { Send, Sparkles, Loader2, AlertCircle } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { emailApi } from '@/lib/api'
import type { EmailDraft } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** If provided, load and edit an existing draft. Otherwise start blank. */
  draftId?: string | null
  /** Fires when "Save as draft" succeeds. */
  onSaved?: (draft: EmailDraft) => void
  /** Fires when "Send" succeeds. */
  onSent?: (draft: EmailDraft) => void
}

interface FormState {
  to: string
  cc: string
  subject: string
  body: string
}

const EMPTY_FORM: FormState = { to: '', cc: '', subject: '', body: '' }

/**
 * Drawer UI for composing or editing an email draft. LLM-assist hits the
 * dedicated `POST /email/compose-draft` endpoint (context-aware agent with
 * search_brain + get_entity tools). Save persists via POST /email/drafts for
 * new drafts or PATCH /email/drafts/:id for existing ones. Send
 * approves-and-sends via POST /email/drafts/:id/send.
 */
export function EmailComposeDrawer({
  open,
  onOpenChange,
  draftId = null,
  onSaved,
  onSent,
}: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(draftId)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // LLM-assist state
  const [assistPrompt, setAssistPrompt] = useState('')
  const [assisting, setAssisting] = useState(false)
  const [assistWarning, setAssistWarning] = useState<string | null>(null)

  // Reset state whenever the drawer opens with a new (or null) draftId.
  useEffect(() => {
    if (!open) return
    setError(null)
    setAssistWarning(null)
    setAssistPrompt('')
    setLoadedDraftId(draftId ?? null)

    if (!draftId) {
      setForm(EMPTY_FORM)
      return
    }

    let cancelled = false
    setLoading(true)
    emailApi
      .get(draftId)
      .then((draft) => {
        if (cancelled) return
        setForm({
          to: draft.to_address ?? '',
          cc: draft.cc_address ?? '',
          subject: draft.subject ?? '',
          body: draft.body ?? '',
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load draft')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, draftId])

  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const toValid = form.to.trim().length > 0
  const subjectValid = form.subject.trim().length > 0
  const bodyValid = form.body.trim().length > 0
  const formValid = toValid && subjectValid && bodyValid

  async function handleAssist() {
    if (!assistPrompt.trim()) {
      setAssistWarning('Describe what you want the email to say first.')
      return
    }
    setAssisting(true)
    setAssistWarning(null)
    try {
      // Build existing-draft context from current form fields. The server-side
      // compose agent uses this to refine rather than rewrite wholesale.
      const existing: {
        to?: string[]
        subject?: string
        body?: string
      } = {}
      const toList = form.to
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (toList.length > 0) existing.to = toList
      if (form.subject.trim()) existing.subject = form.subject.trim()
      if (form.body.trim()) existing.body = form.body.trim()

      const result = await emailApi.composeDraft(
        assistPrompt.trim(),
        Object.keys(existing).length > 0 ? existing : undefined,
      )
      const body = (result.body ?? '').trim()
      if (!body) {
        setAssistWarning('AI returned an empty response. Try rephrasing.')
      } else {
        update('body', body)
        // If the agent proposed a subject and the user hadn't set one, fill it in.
        if (result.subject && !form.subject.trim()) {
          update('subject', result.subject)
        }
        setAssistPrompt('')
      }
    } catch (err) {
      setAssistWarning(
        err instanceof Error ? err.message : 'AI draft failed — keep editing manually.',
      )
    } finally {
      setAssisting(false)
    }
  }

  async function handleSave(): Promise<EmailDraft | null> {
    if (!formValid) {
      setError('To, Subject, and Body are all required.')
      return null
    }
    setSaving(true)
    setError(null)
    try {
      // Editing existing draft → PATCH in place. The server returns the full
      // updated EmailDraft (not the minimal create response).
      if (loadedDraftId) {
        const toList = form.to
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        const ccList = form.cc
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        const updated = await emailApi.update(loadedDraftId, {
          to: toList,
          cc: ccList,
          subject: form.subject.trim(),
          body: form.body.trim(),
        })
        onSaved?.(updated)
        return updated
      }

      // New draft → POST. Backend returns { id, status, send_mode, created_at };
      // refetch for the full draft record to hand back to the caller.
      const created = await emailApi.create({
        to: form.to.trim(),
        subject: form.subject.trim(),
        body: form.body.trim(),
        cc: form.cc.trim() || undefined,
        source: 'web-compose',
      })
      const full = await emailApi.get(created.id)
      setLoadedDraftId(full.id)
      onSaved?.(full)
      return full
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function handleSend() {
    if (!formValid) {
      setError('To, Subject, and Body are all required.')
      return
    }
    setSending(true)
    setError(null)
    try {
      // If the in-memory form has never been saved (no loadedDraftId), save first.
      let targetId = loadedDraftId
      if (!targetId) {
        const saved = await handleSave()
        if (!saved) {
          setSending(false)
          return
        }
        targetId = saved.id
      }
      const sent = await emailApi.send(targetId)
      onSent?.(sent)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const isEditing = Boolean(loadedDraftId)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col overflow-y-auto"
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>{isEditing ? 'Edit draft' : 'Compose'}</SheetTitle>
          <SheetDescription>
            Compose an email; save as draft for review or send immediately.
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading draft…
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-4 mt-4">
            {/* To */}
            <div className="flex flex-col gap-1">
              <label htmlFor="compose-to" className="text-xs font-medium">
                To {!toValid && <span className="text-destructive">*</span>}
              </label>
              <Input
                id="compose-to"
                placeholder="name@example.com, another@example.com"
                value={form.to}
                onChange={(e) => update('to', e.target.value)}
              />
            </div>

            {/* Cc */}
            <div className="flex flex-col gap-1">
              <label htmlFor="compose-cc" className="text-xs font-medium">
                Cc <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="compose-cc"
                placeholder="cc@example.com"
                value={form.cc}
                onChange={(e) => update('cc', e.target.value)}
              />
            </div>

            {/* Subject */}
            <div className="flex flex-col gap-1">
              <label htmlFor="compose-subject" className="text-xs font-medium">
                Subject {!subjectValid && <span className="text-destructive">*</span>}
              </label>
              <Input
                id="compose-subject"
                placeholder="Email subject"
                value={form.subject}
                onChange={(e) => update('subject', e.target.value)}
              />
            </div>

            {/* LLM-assist */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <label
                htmlFor="compose-assist"
                className="text-xs font-medium flex items-center gap-1"
              >
                <Sparkles className="h-3.5 w-3.5" />
                What do you want to say?
              </label>
              <div className="flex gap-2">
                <Input
                  id="compose-assist"
                  placeholder="e.g. politely decline the meeting"
                  value={assistPrompt}
                  onChange={(e) => setAssistPrompt(e.target.value)}
                  disabled={assisting}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !assisting) {
                      e.preventDefault()
                      handleAssist()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleAssist}
                  disabled={assisting}
                  className="shrink-0 gap-1"
                >
                  {assisting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Draft with AI
                </Button>
              </div>
              {assistWarning && (
                <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {assistWarning}
                </p>
              )}
            </div>

            {/* Body */}
            <div className="flex flex-col gap-1 flex-1">
              <label htmlFor="compose-body" className="text-xs font-medium">
                Body {!bodyValid && <span className="text-destructive">*</span>}
              </label>
              <textarea
                id="compose-body"
                rows={14}
                value={form.body}
                onChange={(e) => update('body', e.target.value)}
                placeholder="Write your message here, or use Draft with AI above."
                className={cn(
                  'flex min-h-[280px] w-full rounded-md border border-input',
                  'bg-background px-3 py-2 text-sm ring-offset-background',
                  'placeholder:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-2',
                  'focus-visible:ring-ring focus-visible:ring-offset-2',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  'resize-y',
                )}
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Sticky footer */}
            <div className="sticky bottom-0 -mx-6 -mb-6 mt-2 flex justify-end gap-2 border-t bg-background px-6 py-3">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={saving || sending}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={handleSave}
                disabled={saving || sending || !formValid}
                className="gap-1"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save as draft
              </Button>
              <Button
                onClick={handleSend}
                disabled={saving || sending || !formValid}
                className="gap-1"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Send
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default EmailComposeDrawer
