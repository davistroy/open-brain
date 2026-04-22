import { redirect } from 'next/navigation';
import { Construction } from 'lucide-react';
import { PageHeader } from '@/components/design-system/PageHeader';
import { EmptyState } from '@/components/design-system/EmptyState';

/** Map of top-level route slug → owning milestone label */
const MILESTONE_MAP: Record<string, string> = {
  timeline:     'Milestone 2',
  ingest:       'Milestone 2',
  voice:        'Milestone 2',
  wiki:         'Milestone 3',
  intelligence: 'Milestone 3',
  board:        'Milestone 3',
  financial:    'Milestone 3',
  investments:  'Milestone 3',
  system:       'Milestone 3',
  settings:     'Milestone 3',
};

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Props {
  params: Promise<{ slug?: string[] }>;
}

/**
 * Catch-all stub for routes not yet implemented.
 * Renders a PageHeader + EmptyState with the owning milestone.
 * Server component — no client state required.
 */
export default async function CatchAllPage({ params }: Props) {
  const { slug } = await params;

  // Root path redirect — no slug segments means the user hit "/"
  if (!slug || slug.length === 0) {
    redirect('/dashboard');
  }

  const topSlug = slug[0];
  const milestone = MILESTONE_MAP[topSlug] ?? 'a future milestone';
  const label = toTitleCase(topSlug.replace(/-/g, ' '));

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', label]}
        title={label}
      />
      <EmptyState
        icon={Construction}
        title={`Coming in ${milestone}`}
        description="This surface is designed but not yet built."
      />
    </>
  );
}

export function generateStaticParams() {
  return Object.keys(MILESTONE_MAP).map((slug) => ({ slug: [slug] }));
}
