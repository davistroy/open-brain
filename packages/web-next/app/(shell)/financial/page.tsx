export const dynamic = 'force-dynamic';

/**
 * Financial page — Phase 5, work item 5.1.
 *
 * RSC: fetches captures for each of 6 financial providers in parallel.
 * Passes provider→captures map to ProviderTabs client component which owns
 * the tab selection state and renders capture cards per tab.
 *
 * Providers pulled from `source_metadata.source_provider` field populated by
 * the financial pipeline (packages/workers utility-pipeline ingest jobs).
 */

import { PageHeader } from '@/components/design-system';
import { ProviderTabs } from '@/components/financial/ProviderTabs';
import { capturesApi } from '@/lib/api-client';
import type { Capture } from '@/lib/types';

/** The 6 financial providers tracked by the utility pipeline. */
export const FINANCIAL_PROVIDERS = [
  { id: 'amex',       label: 'Amex' },
  { id: 'fidelity',   label: 'Fidelity' },
  { id: 'chase',      label: 'Chase' },
  { id: 'vanguard',   label: 'Vanguard' },
  { id: 'simplefin',  label: 'SimpleFin' },
  { id: 'other',      label: 'Other' },
] as const;

export type ProviderId = (typeof FINANCIAL_PROVIDERS)[number]['id'];

/**
 * Parallel-fetch captures for all 6 providers.
 * Returns a map keyed by provider id. Falls back to empty array on per-provider error
 * so one failing source does not blank the whole page.
 */
async function fetchProviderCaptures(): Promise<Record<ProviderId, Capture[]>> {
  const results = await Promise.allSettled(
    FINANCIAL_PROVIDERS.map((p) =>
      capturesApi.list({ source_provider: p.id, limit: 25 }),
    ),
  );

  return Object.fromEntries(
    FINANCIAL_PROVIDERS.map((p, i) => {
      const result = results[i];
      const items = result.status === 'fulfilled' ? result.value.items : [];
      return [p.id, items];
    }),
  ) as Record<ProviderId, Capture[]>;
}

export default async function FinancialPage() {
  const capturesByProvider = await fetchProviderCaptures();

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Financial']}
        title="Financial"
        subtitle="Transaction and balance captures grouped by financial provider"
      />

      <ProviderTabs
        providers={FINANCIAL_PROVIDERS}
        capturesByProvider={capturesByProvider}
      />
    </>
  );
}
