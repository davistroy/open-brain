'use client';

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

interface Source {
  id: string;
  name: string;
  description: string;
  icon: string;          // SVG path string
  instructions: string;
  /** Optional badge text e.g. "Recommended" */
  badge?: string;
}

const SOURCES: Source[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Capture important threads, decisions, and action items from your inbox.',
    icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
    instructions: 'Forward emails to brain@troy-davis.com — or set up a Gmail filter to auto-forward. All forwarded mail is captured as a "email" source capture.',
    badge: 'Recommended',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Log meetings, agendas, and outcomes automatically from your calendar.',
    icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zm-7 5h5v5h-5z',
    instructions: 'Share your calendar events as email summaries to brain@troy-davis.com. Use a calendar automation (e.g. n8n or Zapier) to send a brief after each meeting.',
  },
  {
    id: 'ios_voice',
    name: 'iOS Voice Notes',
    description: 'Record voice memos on iPhone or Apple Watch — transcribed automatically.',
    icon: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z',
    instructions: 'Use the Open Brain iOS Shortcut: tap "Record to Brain" → speak → Shortcut uploads to voice-capture endpoint. Add the Shortcut from Settings → Shortcuts → Shared.',
    badge: 'Recommended',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Capture messages, decisions, and threads from your workspace.',
    icon: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
    instructions: 'Install the Open Brain Slack bot to your workspace. DM it or @mention it in any channel with thoughts, decisions, or questions.',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    description: 'Ingest documents, meeting notes, and files from your Drive.',
    icon: 'M12 2L2 19h5.5l1.5-3h6l1.5 3H22L12 2zm0 3.5l3.74 7H8.26L12 5.5z',
    instructions: 'Use the Open Brain ingest tool: drag files onto the /ingest page, or configure the rclone sync to pull from a specific Drive folder on a schedule.',
  },
  {
    id: 'email_forwarding',
    name: 'Email forwarding',
    description: 'Forward any email to brain@troy-davis.com — the universal capture channel.',
    icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-7 7.5L4.5 6.5h15L13 11.5zm7 6.5H4V8.5l9 5.5 9-5.5V18z',
    instructions: 'Forward any email to brain@troy-davis.com. Your sender address is automatically added to the allowlist on first use. Use the + alias trick for filtered auto-forward rules.',
  },
];

// ---------------------------------------------------------------------------
// Setup instructions panel
// ---------------------------------------------------------------------------

interface InstructionsProps {
  source: Source;
}

function Instructions({ source }: InstructionsProps) {
  return (
    <div
      className="mt-3 p-3 rounded-sm text-[13px] leading-relaxed"
      style={{
        backgroundColor: 'var(--color-book-cloth-50)',
        borderLeft: '3px solid var(--color-book-cloth)',
        color: 'var(--color-text-body)',
      }}
    >
      <p className="font-semibold mb-1" style={{ color: 'var(--color-book-cloth-dark)' }}>
        How to connect
      </p>
      <p style={{ margin: 0, color: 'var(--color-text-body)' }}>{source.instructions}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source card
// ---------------------------------------------------------------------------

interface SourceCardProps {
  source: Source;
  selected: boolean;
  onToggle: (id: string) => void;
}

function SourceCard({ source, selected, onToggle }: SourceCardProps) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => onToggle(source.id)}
        aria-pressed={selected}
        className="relative w-full text-left p-4 transition-all duration-150 focus-visible:outline-none"
        style={{
          backgroundColor: selected
            ? 'var(--color-book-cloth-50)'
            : 'var(--color-bg-container)',
          border: selected
            ? '2px solid var(--color-book-cloth)'
            : '1px solid var(--color-border-divider)',
          borderRadius: 'var(--border-radius-container)',
          boxShadow: selected ? 'none' : 'var(--shadow-container)',
          cursor: 'pointer',
          // Compensate border width difference to prevent layout shift
          margin: selected ? '0' : '1px',
        }}
      >
        {/* Badge */}
        {source.badge && (
          <span
            className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-sm font-semibold uppercase tracking-wide"
            style={{
              backgroundColor: 'var(--color-book-cloth)',
              color: 'white',
              letterSpacing: '0.05em',
            }}
          >
            {source.badge}
          </span>
        )}

        {/* Icon + title row */}
        <div className="flex items-start gap-3">
          <div
            className="flex-shrink-0 w-9 h-9 rounded-sm flex items-center justify-center"
            style={{
              backgroundColor: selected
                ? 'var(--color-book-cloth)'
                : 'var(--color-ivory-medium)',
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill={selected ? 'white' : 'var(--color-slate-light)'}
              aria-hidden="true"
            >
              <path d={source.icon} />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <p
              className="font-semibold text-[14px] leading-tight mb-0.5"
              style={{ color: 'var(--color-text-heading)' }}
            >
              {source.name}
            </p>
            <p
              className="text-[12px] leading-snug"
              style={{ color: 'var(--color-text-body-secondary)', margin: 0 }}
            >
              {source.description}
            </p>
          </div>

          {/* Selection indicator */}
          <div
            className="flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors duration-150 mt-0.5"
            style={{
              borderColor: selected ? 'var(--color-book-cloth)' : 'var(--color-cloud-medium)',
              backgroundColor: selected ? 'var(--color-book-cloth)' : 'transparent',
            }}
            aria-hidden="true"
          >
            {selected && (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <circle cx="4" cy="4" r="2" fill="white" />
              </svg>
            )}
          </div>
        </div>
      </button>

      {/* Inline instructions on selection */}
      {selected && <Instructions source={source} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceGrid — exported component
// ---------------------------------------------------------------------------

interface SourceGridProps {
  /** Set of selected source IDs */
  selected: Set<string>;
  onToggle: (id: string) => void;
}

/**
 * SourceGrid — 6-card grid for Step 2 of the onboarding wizard.
 * Cards are toggleable — selecting one expands setup instructions inline.
 * No OAuth — purely instructional.
 */
export function SourceGrid({ selected, onToggle }: SourceGridProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SOURCES.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            selected={selected.has(source.id)}
            onToggle={onToggle}
          />
        ))}
      </div>

      {selected.size > 0 && (
        <p
          className="text-center text-[12px] mt-1"
          style={{ color: 'var(--color-text-small)' }}
        >
          {selected.size} source{selected.size !== 1 ? 's' : ''} selected — follow the setup
          instructions above for each one.
        </p>
      )}
    </div>
  );
}
