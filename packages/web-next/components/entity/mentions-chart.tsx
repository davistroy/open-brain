interface MentionsChartProps {
  /**
   * Bar height values. Recent bars (last 5) render in book-cloth;
   * older bars in cloud-dark. Max 36 bars.
   */
  values?: number[];
  firstLabel?: string;
  lastLabel?: string;
}

const DEFAULT_VALUES = [
  2, 3, 4, 3, 5, 6, 4, 7, 8, 6, 9, 8, 10, 7, 9, 11, 8, 10, 9, 7, 8, 9, 6, 8,
  10, 9, 11, 8, 10, 12, 14, 11, 9, 10, 12, 14,
];

/**
 * Mini bar chart showing mentions over time.
 * Recent bars render in book-cloth; older bars in cloud-dark.
 * Matches 06-entity-detail.html:206-213.
 * Server component.
 */
export function MentionsChart({
  values = DEFAULT_VALUES,
  firstLabel = "AUG '23",
  lastLabel = "APR '26",
}: MentionsChartProps) {
  const maxVal = Math.max(...values);
  const CHART_HEIGHT = 56;

  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT }}>
        {values.map((v, i) => {
          const isRecent = i > values.length - 6;
          const barHeight = Math.round((v / maxVal) * CHART_HEIGHT);
          return (
            <div
              key={i}
              className="flex-1"
              style={{
                height: barHeight,
                background: isRecent
                  ? 'var(--color-book-cloth)'
                  : 'var(--color-cloud-dark)',
              }}
            />
          );
        })}
      </div>
      <div
        className="flex justify-between mt-2 text-text-body-secondary"
        style={{
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 10,
          letterSpacing: '0.03em',
        }}
      >
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  );
}
