import { ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/design-system';
import type { Commitment } from '@/lib/types';

interface CommitmentsCardProps {
  commitments: Commitment[];
}

/**
 * Active commitments grid — 4 columns: who/what/due/link.
 * Overdue items render due date in faded-red.
 * Matches 06-entity-detail.html:168-184.
 * Server component.
 */
export function CommitmentsCard({ commitments }: CommitmentsCardProps) {
  return (
    <Card
      header="Active commitments"
      description="Extracted from captures — waiting, owing, or asked"
      padded={false}
    >
      {commitments.map((c, i) => (
        <div
          key={i}
          className="flex items-center border-b border-cloud-light last:border-b-0"
          style={{
            padding: '12px 18px',
            display: 'grid',
            gridTemplateColumns: '150px 1fr 120px 24px',
            gap: 16,
            alignItems: 'center',
          }}
        >
          {/* Who */}
          <span
            className="text-text-body-secondary"
            style={{
              fontFamily: 'var(--font-family-monospace)',
              fontSize: 10.5,
              letterSpacing: '0.04em',
            }}
          >
            {c.who.toUpperCase()}
          </span>

          {/* What */}
          <span
            className="text-text-heading"
            style={{ fontSize: 13 }}
          >
            {c.what}
          </span>

          {/* Due */}
          <span
            style={{
              fontFamily: 'var(--font-family-monospace)',
              fontSize: 11,
              color:
                c.state === 'overdue'
                  ? 'var(--color-faded-red)'
                  : 'var(--color-text-body)',
              letterSpacing: '0.02em',
            }}
          >
            {c.due.toUpperCase()}
          </span>

          {/* Link icon */}
          <button
            className="flex items-center justify-center bg-transparent border-none cursor-pointer p-0"
            aria-label={`Open commitment: ${c.what}`}
          >
            <ArrowUpRight
              size={13}
              strokeWidth={1.5}
              style={{ color: 'var(--color-cloud-dark)' }}
            />
          </button>
        </div>
      ))}
    </Card>
  );
}
