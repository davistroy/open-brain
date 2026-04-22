export const dynamic = 'force-dynamic';

/**
 * Investments page — Phase 5, work item 5.4.
 *
 * RSC: fetches raw Schwab captures (source_provider='schwab', limit=200)
 * in a single call. All shaping (latestBalances, latestPositions,
 * balanceHistory) is done client-side in HoldingsTable and AllocationChart
 * to keep this layer thin.
 *
 * Account filter is URL-driven (?account=<name>) — read as a searchParam
 * and forwarded to client components as the initial selection. Client
 * components pick it up via useSearchParams for full interactivity.
 *
 * If the API fails we pass an empty array — client components render an
 * appropriate empty state with an ingest prompt.
 */

import { PageHeader } from '@/components/design-system';
import { HoldingsTable } from '@/components/investments/HoldingsTable';
import { AllocationChart } from '@/components/investments/AllocationChart';
import { investmentsApi } from '@/lib/api-client';
import type { Capture } from '@/lib/types';

async function fetchSchwabCaptures(): Promise<Capture[]> {
  try {
    const envelope = await investmentsApi.rawCaptures(200);
    return envelope.items;
  } catch {
    return [];
  }
}

export default async function InvestmentsPage() {
  const captures = await fetchSchwabCaptures();

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Investments']}
        title="Investments"
        subtitle="Schwab balance and positions snapshots — sortable holdings, allocation view, and balance history."
      />

      {/* Two-column upper section: allocation donut + net worth/gainers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[18px] mb-[18px]">
        <AllocationChart captures={captures} section="allocation" />
        <AllocationChart captures={captures} section="networth" />
      </div>

      {/* Balance history chart — full width */}
      <div className="mb-[18px]">
        <AllocationChart captures={captures} section="history" />
      </div>

      {/* Holdings table — full width */}
      <HoldingsTable captures={captures} />
    </>
  );
}
