import type { RelatedEntity } from '@/lib/types';

interface RelationshipGraphProps {
  entities: RelatedEntity[];
  initials: string;
}

/**
 * SVG radial relationship graph.
 * Concentric dashed rings + connection lines + node circles with labels.
 * Direct port of the trig code from 06-entity-detail.html:36-71.
 * Server component.
 */
export function RelationshipGraph({ entities, initials }: RelationshipGraphProps) {
  const cx = 160;
  const cy = 110;
  const r = 78;

  return (
    <svg
      viewBox="0 0 320 220"
      style={{
        width: '100%',
        height: 220,
        background: 'var(--color-bg-container)',
        display: 'block',
      }}
      aria-label="Relationship graph"
      role="img"
    >
      {/* Concentric dashed rings */}
      {([30, 55, 80] as const).map((rr) => (
        <circle
          key={rr}
          cx={cx}
          cy={cy}
          r={rr}
          fill="none"
          stroke="var(--color-cloud-light)"
          strokeDasharray="1 3"
        />
      ))}

      {/* Connection lines from center to each node */}
      {entities.map((_, i) => {
        const angle = (i / entities.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        return (
          <line
            key={`line-${i}`}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--color-cloud-medium)"
            strokeWidth="1"
          />
        );
      })}

      {/* Node circles + labels */}
      {entities.map((entity, i) => {
        const angle = (i / entities.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        const lx = cx + Math.cos(angle) * (r + 22);
        const ly = cy + Math.sin(angle) * (r + 22);
        const anchor =
          Math.cos(angle) > 0.3
            ? 'start'
            : Math.cos(angle) < -0.3
              ? 'end'
              : 'middle';

        return (
          <g key={`node-${i}`}>
            <circle cx={x} cy={y} r={4} fill="var(--color-slate-medium)" />
            <text
              x={lx}
              y={ly}
              textAnchor={anchor}
              dominantBaseline="middle"
              style={{
                fontFamily: 'var(--font-family-base)',
                fontSize: 10.5,
                fill: 'var(--color-text-body)',
              }}
            >
              {entity.name}
            </text>
          </g>
        );
      })}

      {/* Center node — book-cloth circle with initials */}
      <circle cx={cx} cy={cy} r={14} fill="var(--color-book-cloth)" />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        style={{
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 10,
          fontWeight: 700,
          fill: 'var(--color-ivory-light)',
        }}
      >
        {initials}
      </text>
    </svg>
  );
}
