/**
 * Help page — Open Brain documentation with TOC sidebar.
 *
 * Server component shell: renders PageHeader + client HelpContent.
 * Content is inline (build-time) — no markdown files, no network calls.
 *
 * Route: /help
 */

import { HelpCircle } from 'lucide-react';
import { PageHeader } from '@/components/design-system';
import { HelpContent } from '@/components/help/HelpContent';

export default function HelpPage() {
  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Help']}
        title="Help"
        subtitle="How Open Brain works — features, shortcuts, and data flow"
        actions={
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            <HelpCircle size={11} strokeWidth={1.5} />
            <span>v1.5.0</span>
          </div>
        }
      />

      {/* HelpContent is a client component — owns IntersectionObserver + active heading state */}
      <HelpContent />
    </>
  );
}
