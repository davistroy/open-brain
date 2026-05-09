/**
 * DashboardEmptyState — shown when total_captures === 0.
 *
 * Server component. Extracted from dashboard/page.tsx to keep the page
 * file under 200 LOC and to replace raw <a> tags with Next.js <Link>.
 */

import Link from 'next/link';
import { Mic, Settings } from 'lucide-react';
import { PageHeader } from '@/components/design-system';
import { EmptyState } from '@/components/design-system/EmptyState';
import { getGreeting } from '@/lib/greeting';

export function DashboardEmptyState() {
  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Dashboard']}
        title={`${getGreeting()}, Troy`}
        subtitle="No captures yet — connect a source or drop a thought to get started."
      />
      <div className="flex flex-col items-center justify-center py-20">
        <EmptyState
          title="Your brain is empty."
          description="Connect a source or capture a thought. Everything starts with one."
          action={
            <div className="flex items-center gap-3 mt-2">
              <Link
                href="/voice"
                className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-none border text-[12px] px-[10px] py-[4px] font-body font-normal tracking-[0.005em] bg-book-cloth border-book-cloth text-ivory-light hover:bg-book-cloth-dark hover:border-book-cloth-dark transition-[background,border-color,color] duration-[120ms]"
              >
                <Mic size={13} strokeWidth={1.5} />
                Voice memo
              </Link>
              <Link
                href="/settings"
                className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-none border text-[12px] px-[10px] py-[4px] font-body font-normal tracking-[0.005em] bg-bg-container border-cloud-medium text-text-heading hover:bg-ivory-dark transition-[background,border-color,color] duration-[120ms]"
              >
                <Settings size={13} strokeWidth={1.5} />
                Connect a source
              </Link>
            </div>
          }
        />
      </div>
    </>
  );
}
