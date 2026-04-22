'use client';

/**
 * HelpContent — renders the Open Brain help documentation with:
 * - TOC sidebar (sticky, desktop) using IntersectionObserver for active heading tracking
 * - Prose content divided into sections by H2 headings
 * - Custom renderers for the section blocks (no ReactMarkdown dependency — inline JSX)
 *
 * Content is hardcoded inline (build-time, zero network calls).
 * Adding a new section: add an entry to SECTIONS, and a matching <section> id.
 */

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Content structure
// ---------------------------------------------------------------------------

interface TocEntry {
  id: string;
  label: string;
}

const TOC: TocEntry[] = [
  { id: 'what-is-open-brain',  label: 'What is Open Brain?' },
  { id: 'capturing',           label: 'Capturing thoughts' },
  { id: 'search',              label: 'Search + synthesis' },
  { id: 'entities',            label: 'Entities' },
  { id: 'briefs',              label: 'Briefs' },
  { id: 'board',               label: 'Board' },
  { id: 'voice',               label: 'Voice' },
  { id: 'settings',            label: 'Settings' },
  { id: 'shortcuts',           label: 'Keyboard shortcuts' },
  { id: 'privacy',             label: 'Privacy + data' },
];

// ---------------------------------------------------------------------------
// TOC sidebar
// ---------------------------------------------------------------------------

function TocSidebar({ activeId }: { activeId: string }) {
  return (
    <nav aria-label="Help contents" className="w-[200px] shrink-0 sticky top-6 self-start hidden lg:block">
      <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)] mb-3">
        Contents
      </p>
      <ul className="space-y-0.5 list-none p-0 m-0">
        {TOC.map(({ id, label }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={[
                'block py-1 px-2 rounded-[2px] font-mono text-[11px] leading-snug transition-colors duration-100 no-underline',
                activeId === id
                  ? 'text-[var(--color-book-cloth)] bg-[var(--color-book-cloth)] bg-opacity-8 font-medium border-l-2 border-[var(--color-book-cloth)] pl-[6px]'
                  : 'text-[var(--color-text-body-secondary)] hover:text-[var(--color-text-body)] border-l-2 border-transparent pl-[6px]',
              ].join(' ')}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Prose helpers
// ---------------------------------------------------------------------------

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="font-display text-[18px] font-normal text-[var(--color-text-heading)] mt-10 mb-3 scroll-mt-6 first:mt-0"
    >
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13.5px] leading-[1.65] text-[var(--color-text-body)] mb-3">
      {children}
    </p>
  );
}

function Ul({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mb-4 space-y-1.5 pl-0 list-none">
      {children}
    </ul>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-[13px] leading-[1.6] text-[var(--color-text-body)]">
      <span className="text-[var(--color-book-cloth)] mt-0.5 shrink-0">·</span>
      <span>{children}</span>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[11.5px] bg-[#f0ebe4] text-[var(--color-text-body)] px-1.5 py-0.5 rounded-[2px]">
      {children}
    </code>
  );
}

function ShortcutTable({ rows }: { rows: { keys: string; action: string }[] }) {
  return (
    <table className="w-full text-[12.5px] border-collapse mb-4">
      <thead>
        <tr className="border-b border-[var(--color-rule)]">
          <th className="text-left font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)] pb-2 pr-6 w-28">Shortcut</th>
          <th className="text-left font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)] pb-2">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ keys, action }) => (
          <tr key={keys} className="border-b border-[var(--color-rule)] border-opacity-50">
            <td className="py-1.5 pr-6">
              <Code>{keys}</Code>
            </td>
            <td className="py-1.5 text-[var(--color-text-body)]">{action}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HelpContent() {
  const [activeId, setActiveId] = useState<string>(TOC[0].id);
  const sectionRefs = useRef<Map<string, IntersectionObserverEntry>>(new Map());

  // IntersectionObserver: track which H2 is closest to the top of the viewport
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          sectionRefs.current.set(entry.target.id, entry);
        }
        // Find the first section that's intersecting, or the last one above fold
        const visible = Array.from(sectionRefs.current.values()).filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          // Pick the one with the smallest top offset (closest to viewport top)
          visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: '-10% 0px -80% 0px',  // Trigger when heading is in top 20% of viewport
        threshold: 0,
      },
    );

    const headings = document.querySelectorAll('[data-help-section]');
    for (const el of headings) observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex gap-10 items-start">
      {/* TOC sidebar */}
      <TocSidebar activeId={activeId} />

      {/* Prose content */}
      <article className="min-w-0 flex-1 max-w-[640px]">

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="what-is-open-brain">
          <H2 id="what-is-open-brain">What is Open Brain?</H2>
          <P>
            Open Brain is a self-hosted personal knowledge infrastructure. It captures thoughts from
            voice memos, Slack, documents, and email — then stores, searches, and synthesizes them
            so nothing important gets lost.
          </P>
          <P>
            Everything you capture is processed through an AI pipeline: classified, embedded for
            semantic search, and linked to named entities (people, projects, topics, decisions).
            Over time, your brain builds a searchable record of decisions, ideas, and observations.
          </P>
          <Ul>
            <Li>Single-user, fully self-hosted — your data never leaves your infrastructure.</Li>
            <Li>All captures flow into one Postgres+pgvector store, searchable by meaning not just keywords.</Li>
            <Li>Five brain views organize context: <Code>career</Code>, <Code>personal</Code>, <Code>technical</Code>, <Code>work-internal</Code>, <Code>client</Code>.</Li>
          </Ul>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="capturing">
          <H2 id="capturing">Capturing thoughts</H2>
          <P>
            Open Brain ingests from multiple sources automatically. You can also capture manually
            from the dashboard Quick Capture widget.
          </P>
          <Ul>
            <Li><strong>Voice (iPhone/Watch):</strong> Use the iOS Shortcut — tap "Record to Brain", speak, done. The Shortcut uploads directly to the voice-capture endpoint. Transcribed by Whisper.</Li>
            <Li><strong>Voice file upload:</strong> Drop an audio file on the <em>Voice Upload</em> page. Accepts MP3, M4A, WAV, AAC, OGG, FLAC up to 50 MB.</Li>
            <Li><strong>Slack:</strong> Mention @OpenBrain in any channel, or send a direct message. Plain messages are captured; <Code>!commands</Code> trigger skills.</Li>
            <Li><strong>Email:</strong> Forward any email to brain@troy-davis.com. Sender must be on the allowlist (Settings → Sources).</Li>
            <Li><strong>Document upload:</strong> Upload PDFs, Word docs, or plain text via the Ingest page. Chunked and embedded automatically.</Li>
            <Li><strong>MCP (Claude integration):</strong> Use the <Code>capture_thought</Code> tool from within Claude conversations.</Li>
            <Li><strong>Quick Capture:</strong> Type directly in the dashboard widget. Classified and embedded in seconds.</Li>
          </Ul>
          <P>
            All captures go through the same pipeline: classify → embed → extract entities → link entities.
            Pipeline status is visible on each capture card (<Code>pending</Code> → <Code>complete</Code>).
          </P>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="search">
          <H2 id="search">Search + synthesis</H2>
          <P>
            Search uses hybrid retrieval: full-text search (FTS) combined with vector similarity,
            re-ranked with RRF (Reciprocal Rank Fusion). Results are weighted by temporal recency
            and Hebbian co-access scores.
          </P>
          <Ul>
            <Li>Plain keywords → hybrid FTS + vector search.</Li>
            <Li>Questions ("What have I captured about…?") → AI synthesis answer card above results.</Li>
            <Li>Filter by brain view using the tabs.</Li>
            <Li>Entity facets in the sidebar narrow results by named entities mentioned.</Li>
          </Ul>
          <P>
            Synthesis routes through the LLM gateway. It aggregates top-matching captures and
            returns a prose answer with citations. It does not make up information — if nothing
            relevant is captured, it says so.
          </P>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="entities">
          <H2 id="entities">Entities</H2>
          <P>
            The pipeline automatically extracts named entities from every capture: people, projects,
            topics, organizations, and decisions. Entities accumulate a mention history and
            relationship graph over time.
          </P>
          <Ul>
            <Li>Entity detail shows: all linked captures, related entities (co-mentioned), and open commitments.</Li>
            <Li>Mention timeline chart shows capture frequency over 90 days.</Li>
            <Li>"Ask a question" lets you query the LLM about a specific entity using its full context.</Li>
            <Li>"Generate brief" produces a DOSSIER brief summarizing everything captured about an entity.</Li>
            <Li>Merge two entities when extraction creates duplicates (e.g. "Troy" vs "Troy Davis").</Li>
          </Ul>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="briefs">
          <H2 id="briefs">Briefs</H2>
          <P>
            Briefs are AI-generated summaries of your captures, produced on a schedule or on demand.
          </P>
          <Ul>
            <Li><strong>Daily brief:</strong> Generated every morning at 07:00 from the previous 24 hours of activity.</Li>
            <Li><strong>Weekly brief:</strong> Generated Sunday at 08:00 — week-in-review format.</Li>
            <Li><strong>Monthly brief:</strong> Generated on the 1st of each month.</Li>
            <Li><strong>DOSSIER brief:</strong> Entity-specific summary — trigger from any entity detail page.</Li>
          </Ul>
          <P>
            Each brief has a TOC sidebar, source citations, and a "Listen" button that synthesizes
            the text to audio via OpenAI TTS. Audio is cached for 24 hours.
          </P>
          <P>
            Use "Refine" to regenerate a section with a different focus (e.g. "Focus on decisions only").
          </P>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="board">
          <H2 id="board">Board</H2>
          <P>
            The Board is a commitments Kanban. The pipeline extracts forward-looking obligations
            from captures — things you owe others, things others owe you, and unresolved pending items.
          </P>
          <Ul>
            <Li><strong>Pending:</strong> Commitments with no assigned direction yet.</Li>
            <Li><strong>You owe:</strong> Things you have committed to do or deliver.</Li>
            <Li><strong>Waiting on:</strong> Things others owe you.</Li>
            <Li><strong>Resolved:</strong> Closed commitments.</Li>
          </Ul>
          <P>
            Click the checkbox or "Mark resolved" on any card to move it to Resolved. Add manual
            commitments with the "New item" button. Overdue items (past due date, not resolved) are
            highlighted in red.
          </P>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="voice">
          <H2 id="voice">Voice</H2>
          <P>
            Voice capture is the fastest input method. Two paths are supported:
          </P>
          <Ul>
            <Li><strong>Live recording (iPhone/Watch):</strong> The iOS Shortcut records, uploads, and returns in under 10 seconds. Setup: Settings → Sources → iOS Voice Notes → follow instructions.</Li>
            <Li><strong>File upload:</strong> Drop pre-recorded audio on the Voice Upload page. Useful for uploading meeting recordings, podcast clips, or dictation files.</Li>
          </Ul>
          <P>
            Transcription uses Whisper (self-hosted faster-whisper). The transcript is then classified
            and enters the normal pipeline. Location metadata is attached if provided by the iOS Shortcut.
          </P>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="settings">
          <H2 id="settings">Settings</H2>
          <Ul>
            <Li><strong>Sources:</strong> View integration health status and connected sources.</Li>
            <Li><strong>Ingest filters:</strong> Toggle automated email skipping, low-signal Slack filtering, and voice minimum duration.</Li>
            <Li><strong>Entity extraction:</strong> Enable/disable location and monetary entity extraction. Adjust confidence threshold.</Li>
            <Li><strong>Danger zone:</strong> Two-step data reset — requires typed confirmation phrase.</Li>
          </Ul>
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="shortcuts">
          <H2 id="shortcuts">Keyboard shortcuts</H2>
          <P>
            All navigation shortcuts use chord keys — press the first key, then the second within 500ms.
            Shortcuts are disabled when focus is inside an input or textarea.
          </P>
          <ShortcutTable rows={[
            { keys: 'g d',   action: 'Go to Dashboard' },
            { keys: 'g e',   action: 'Go to Entities' },
            { keys: 'g b',   action: 'Go to Briefs' },
            { keys: 'g s',   action: 'Go to Search' },
            { keys: '/',     action: 'Focus search input' },
            { keys: '?',     action: 'Open shortcuts help modal' },
          ]} />
        </section>

        {/* ----------------------------------------------------------------- */}
        <section data-help-section id="privacy">
          <H2 id="privacy">Privacy + data</H2>
          <P>
            Open Brain is entirely self-hosted. Data is stored in your own Postgres database
            on your home server. The only external services used are:
          </P>
          <Ul>
            <Li><strong>OpenAI API:</strong> Embeddings and LLM inference for synthesis, briefs, and entity extraction. Text is sent to OpenAI per their standard API terms.</Li>
            <Li><strong>Cloudflare Tunnel:</strong> Routes HTTPS traffic to your home server. Cloudflare sees request metadata but not database contents.</Li>
            <Li><strong>Pushover:</strong> Notification delivery for alerts (optional).</Li>
          </Ul>
          <P>
            Email captured via brain@troy-davis.com passes through Cloudflare Email Workers before
            reaching core-api. Only senders on the allowlist are accepted.
          </P>
          <P>
            All captures can be deleted individually or via the Danger Zone reset (two-step
            confirmation required). Deleted captures are soft-deleted and excluded from search
            immediately.
          </P>
        </section>

      </article>
    </div>
  );
}
