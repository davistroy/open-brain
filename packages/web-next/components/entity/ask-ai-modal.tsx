'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sparkles, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { entitiesApi } from '@/lib/api-client';

interface AskAIModalProps {
  entityId: string;
  entityName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal for asking the AI a question about a specific entity.
 * Uses Radix Dialog + entitiesApi.ask (POST /entities/:id/ask).
 * Client component.
 */
export function AskAIModal({ entityId, entityName, open, onOpenChange }: AskAIModalProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const firstName = entityName.split(' ')[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;

    setLoading(true);
    setAnswer(null);

    try {
      const result = await entitiesApi.ask(entityId, q);
      setAnswer(result.answer);
    } catch {
      toast.error('Failed to get answer. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      // Reset state when closing
      setQuestion('');
      setAnswer(null);
      setLoading(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        {/* Overlay */}
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0, 0, 0, 0.45)' }}
        />

        {/* Content panel */}
        <Dialog.Content
          className="fixed z-50 bg-bg-container border border-cloud-medium"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            maxWidth: 560,
            maxHeight: '80vh',
            overflow: 'auto',
            padding: '28px 28px 24px',
            outline: 'none',
          }}
          aria-describedby="ask-ai-desc"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-[10px]">
              <Sparkles
                size={15}
                strokeWidth={1.5}
                style={{ color: 'var(--color-book-cloth)' }}
              />
              <Dialog.Title
                className="text-text-heading"
                style={{
                  fontFamily: 'var(--font-family-display)',
                  fontSize: 18,
                  fontWeight: 300,
                  letterSpacing: '-0.01em',
                  margin: 0,
                }}
              >
                Ask AI about {firstName}
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                className="flex items-center justify-center bg-transparent border-none cursor-pointer"
                aria-label="Close"
                style={{ padding: 4, color: 'var(--color-text-body-secondary)' }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          <p
            id="ask-ai-desc"
            className="text-text-body-secondary"
            style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}
          >
            Ask anything about {entityName} based on your captures.
          </p>

          {/* Question form */}
          <form onSubmit={handleSubmit}>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={`e.g. "What are the open commitments with ${firstName}?"`}
              disabled={loading}
              className="w-full border border-cloud-medium bg-bg-container text-text-heading"
              style={{
                padding: '10px 12px',
                fontSize: 13.5,
                lineHeight: 1.55,
                resize: 'vertical',
                minHeight: 88,
                outline: 'none',
                fontFamily: 'var(--font-family-base)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit(e as unknown as React.FormEvent);
                }
              }}
            />

            <div className="flex items-center justify-between mt-3">
              <span
                className="text-text-body-secondary"
                style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 10.5 }}
              >
                ⌘↵ to submit
              </span>
              <button
                type="submit"
                disabled={loading || !question.trim()}
                className="flex items-center gap-2"
                style={{
                  padding: '7px 16px',
                  background: loading || !question.trim()
                    ? 'var(--color-cloud-medium)'
                    : 'var(--color-book-cloth)',
                  color: 'var(--color-ivory-light)',
                  border: 'none',
                  cursor: loading || !question.trim() ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontFamily: 'var(--font-family-base)',
                }}
              >
                {loading && <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />}
                {loading ? 'Thinking…' : 'Ask'}
              </button>
            </div>
          </form>

          {/* Response */}
          {answer && (
            <div
              style={{
                marginTop: 20,
                borderTop: '1px solid var(--color-cloud-light)',
                paddingTop: 18,
              }}
            >
              <div
                className="flex items-center gap-2 mb-3"
              >
                <Sparkles
                  size={11}
                  strokeWidth={1.5}
                  style={{ color: 'var(--color-book-cloth-dark)' }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-family-monospace)',
                    fontSize: 10.5,
                    color: 'var(--color-book-cloth-dark)',
                    letterSpacing: '0.06em',
                  }}
                >
                  AI ANSWER
                </span>
              </div>
              <p
                className="text-text-heading"
                style={{
                  fontFamily: 'var(--font-family-display)',
                  fontSize: 15,
                  fontWeight: 300,
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {answer}
              </p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
