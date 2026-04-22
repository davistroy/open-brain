import { Card, Pill } from '@/components/design-system';
import type { Entity, BoardCommitment } from '@/lib/types';

interface ExtractionsSidebarProps {
  entities: Entity[];
  commitments: BoardCommitment[];
  captureContent: string;
}

/** Extract decision sentences from capture content (heuristic: lines with "decided", "will", etc.). */
function extractDecisions(content: string): string[] {
  const decisionKeywords = [
    /\bdecid(ed|ing|e)\b/i,
    /\bcommit(ted|ting|s)?\b/i,
    /\bwill\s+(go|proceed|implement|use|build|move|start)\b/i,
    /\bchose?\b/i,
    /\bselect(ed|ing)?\b/i,
    /\bapprove?d?\b/i,
    /\bfinal\s+decision\b/i,
  ];

  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 200);

  const decisions = sentences.filter((s) =>
    decisionKeywords.some((re) => re.test(s)),
  );

  return decisions.slice(0, 5);
}

/** Format commitment status for display. */
function commitmentStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: 'PENDING',
    owed_by_user: 'YOU OWE',
    waiting_on: 'WAITING ON',
    resolved: 'RESOLVED',
  };
  return map[status] ?? status.toUpperCase();
}

/** Format ISO date for due-date badge display. */
function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const [year, month, day] = iso.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Returns true if due_date is past. */
function isOverdue(iso: string): boolean {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return iso < todayStr;
}

/**
 * Extractions sidebar — Cloudscape screen 10 right column.
 * Three Card sections:
 *  - Entities: accent pills, wrapped
 *  - Decisions: 2px book-cloth left-border items (heuristic extraction from content)
 *  - Commitments: status label + due date badge
 * Server component.
 */
export function ExtractionsSidebar({
  entities,
  commitments,
  captureContent,
}: ExtractionsSidebarProps) {
  const decisions = extractDecisions(captureContent);

  return (
    <div className="flex flex-col gap-4">
      {/* Entities */}
      <Card header="Entities" padded>
        {entities.length === 0 ? (
          <p
            className="text-text-body-secondary m-0"
            style={{ fontSize: 12.5, fontStyle: 'italic' }}
          >
            No entities linked yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-[6px]">
            {entities.map((entity) => (
              <Pill key={entity.id} tone="accent" size="sm">
                <span
                  style={{
                    fontFamily: 'var(--font-family-monospace)',
                    fontSize: 10.5,
                    letterSpacing: '0.04em',
                  }}
                >
                  {entity.name}
                </span>
              </Pill>
            ))}
          </div>
        )}
      </Card>

      {/* Decisions */}
      {decisions.length > 0 && (
        <Card header="Decisions" padded>
          <div className="flex flex-col gap-[10px]">
            {decisions.map((decision, i) => (
              <div
                key={i}
                style={{
                  borderLeft: '2px solid var(--color-book-cloth)',
                  paddingLeft: 12,
                }}
              >
                <p
                  className="m-0 text-text-body"
                  style={{ fontSize: 13, fontWeight: 300, lineHeight: 1.6 }}
                >
                  {decision}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Commitments */}
      <Card header="Commitments" padded={false}>
        {commitments.length === 0 ? (
          <div className="px-[18px] py-[14px]">
            <p
              className="text-text-body-secondary m-0"
              style={{ fontSize: 12.5, fontStyle: 'italic' }}
            >
              No commitments extracted.
            </p>
          </div>
        ) : (
          <div>
            {commitments.map((c) => {
              const due = formatDueDate(c.due_date);
              const overdue = c.due_date ? isOverdue(c.due_date) : false;

              return (
                <div
                  key={c.id}
                  className="flex items-start gap-3 px-[18px] py-[11px] border-b border-cloud-light last:border-0"
                >
                  {/* Status pill */}
                  <div className="flex-shrink-0 mt-[2px]">
                    <span
                      style={{
                        fontFamily: 'var(--font-family-monospace)',
                        fontSize: 9.5,
                        letterSpacing: '0.07em',
                        color: 'var(--color-book-cloth-dark)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {commitmentStatusLabel(c.status)}
                    </span>
                  </div>

                  {/* Text + due date */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="m-0 text-text-heading"
                      style={{ fontSize: 13, fontWeight: 400, lineHeight: 1.5 }}
                    >
                      {c.text}
                    </p>

                    {due && (
                      <span
                        style={{
                          display: 'inline-block',
                          marginTop: 4,
                          fontFamily: 'var(--font-family-monospace)',
                          fontSize: 9.5,
                          letterSpacing: '0.06em',
                          padding: '1px 5px',
                          background: overdue
                            ? 'var(--color-status-error-bg)'
                            : 'var(--color-cloud-light)',
                          color: overdue
                            ? 'var(--color-status-error-fg)'
                            : 'var(--color-text-body-secondary)',
                          border: overdue
                            ? '1px solid var(--color-status-error-border)'
                            : 'none',
                        }}
                      >
                        DUE {due.toUpperCase()}
                        {overdue ? ' · OVERDUE' : ''}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
