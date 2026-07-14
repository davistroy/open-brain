/**
 * Typed mock data fixtures for all 5 M1 screens.
 *
 * All shapes mirror real API response envelopes — M2 wiring swaps these
 * constants for live fetch calls with zero interface changes.
 *
 * Data extracted from reference screens:
 *   01-dashboard.html, 05-entities.html, 06-entity-detail.html,
 *   07-briefs.html, 08-brief-detail.html
 */

import type {
  Capture,
  Entity,
  EntityDetail,
  Brief,
  BriefDetail,
  DashboardStats,
  OpenQuestion,
  UpcomingBrief,
  TimelineEntry,
  EntityDistribution,
  NeedsAttentionItem,
} from './types';

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export const mockStats: DashboardStats = {
  captures_7d: 84,
  captures_7d_delta: '▲ 12%',
  captures_7d_meta: 'avg 12/day · on target',
  active_entities: 217,
  active_entities_delta: '▲ 4',
  active_entities_meta: '3 new this week',
  open_questions: 9,
  open_questions_delta: '▼ 2',
  open_questions_meta: '2 overdue · 7 on track',
  briefs_in_progress: 3,
  briefs_due_meta: 'next due Thursday',
  pipeline_status: 'healthy',
  pipeline_active: 3,
  pipeline_queued: 12,
  pipeline_failed: 0,
  llm_spend_usd: 4.82,
  capture_total: 1847,
  entity_total: 217,
};

// ---------------------------------------------------------------------------
// Open questions (dashboard right column)
// ---------------------------------------------------------------------------

export const mockOpenQuestions: OpenQuestion[] = [
  {
    id: 'q1',
    question: 'October front-loaded hiring vs. rolling through Q4?',
    due: '3d',
    priority: 'high',
    context: '3 related captures',
  },
  {
    id: 'q2',
    question: 'Decide: Lelit Bianca vs ECM Synchronika',
    due: '5d',
    priority: 'med',
    context: '2 captures · 1 brief',
  },
  {
    id: 'q3',
    question: 'Should Maya pivot to ML eng this quarter?',
    due: 'flex',
    priority: 'med',
    context: '4 related captures',
  },
  {
    id: 'q4',
    question: 'Budget for advisory board offsite?',
    due: 'overdue',
    priority: 'high',
    context: '2 captures',
  },
];

// ---------------------------------------------------------------------------
// Upcoming briefs (dashboard right column)
// ---------------------------------------------------------------------------

export const mockUpcomingBriefs: UpcomingBrief[] = [
  { id: 'ub1', title: 'Q4 Planning — decision memo', progress: 72, due: 'Thu', source_count: 12 },
  { id: 'ub2', title: 'Advisory board pre-read', progress: 40, due: 'next Tue', source_count: 8 },
  { id: 'ub3', title: 'Espresso machine decision', progress: 88, due: 'Apr 30', source_count: 4 },
];

// ---------------------------------------------------------------------------
// Recent captures (dashboard + timeline)
// ---------------------------------------------------------------------------

export const mockCaptures: Capture[] = [
  {
    id: 'c1',
    title: 'Morning walk — Q4 planning thoughts',
    snippet: 'Need to circle back with Sarah on headcount for the new team…',
    content: 'Need to circle back with Sarah on headcount for the new team. The December ramp feels too aggressive given the London office timeline. Should loop in Ravi on the finance side before Thursday.',
    capture_type: 'observation',
    source: 'voice',
    pipeline_status: 'complete',
    brain_view: 'work-internal',
    created_at: '2026-04-21T07:12:00Z',
    entities: ['Sarah Chen', 'Q4 Planning', 'Hiring'],
  },
  {
    id: 'c2',
    title: 'Re: Advisory board deck v3',
    snippet: "avi@ventures.co — 'Comments on slides 12–18 inline. Can we discuss…'",
    content: "avi@ventures.co — 'Comments on slides 12–18 inline. Can we discuss the valuation slide before Tuesday? I think the comp table is misleading without the revenue forecast context.'",
    capture_type: 'task',
    source: 'email',
    pipeline_status: 'extracted',
    brain_view: 'work-internal',
    created_at: '2026-04-21T07:04:00Z',
    entities: ['Avi Sharma', 'Ventures.co', 'Advisory Board'],
  },
  {
    id: 'c3',
    title: 'espresso-machine-research.pdf',
    snippet: '12-page comparison of Lelit vs ECM vs Profitec in the $2.5–4k range',
    content: '12-page comparison of Lelit vs ECM vs Profitec in the $2.5–4k range. Key differentiators: E61 vs lever vs rotary pump. Lelit Bianca wins on PID and flow control at $2,800. ECM Synchronika wins on build quality and longevity at $3,200.',
    capture_type: 'decision',
    source: 'document',
    pipeline_status: 'complete',
    brain_view: 'personal',
    created_at: '2026-04-20T18:30:00Z',
    entities: ['Home Office', 'Purchase Decision'],
  },
  {
    id: 'c4',
    title: 'Weekly 1:1 with Maya — notes',
    snippet: 'Career goals, mentorship ask, ML certification discussion',
    content: 'Career goals, mentorship ask, ML certification discussion. Maya raised the Stanford ML cert as a 6-month path. Wants customer call exposure as part of the transition. I said I\'d think about it — need to follow up. She also asked about promotion timeline.',
    capture_type: 'observation',
    source: 'api',
    pipeline_status: 'complete',
    brain_view: 'work-internal',
    created_at: '2026-04-20T14:00:00Z',
    entities: ['Maya Rodriguez', '1:1', 'Career Development'],
  },
  {
    id: 'c5',
    title: 'Book idea — "operating system for a life"',
    snippet: 'What if personal knowledge management borrowed from ops playbooks?',
    content: 'What if personal knowledge management borrowed from ops playbooks? The idea: treat your life like a distributed system. Captures are events. Weekly reviews are health checks. Decisions are state transitions. Briefs are runbooks. Could be a book or a long essay.',
    capture_type: 'idea',
    source: 'api',
    pipeline_status: 'embedded',
    brain_view: 'personal',
    created_at: '2026-04-19T20:15:00Z',
    entities: ['Book Ideas', 'Writing'],
  },
  {
    id: 'c6',
    title: 'simonwillison.net — Datasette for personal data',
    snippet: 'Bookmarked — might be useful for Open Brain data export design',
    content: 'Bookmarked — might be useful for Open Brain data export design. Datasette can serve SQLite over HTTP with full-text search and faceting. Could be the read-only export layer for Open Brain captures, avoiding the need to build a separate export API.',
    capture_type: 'idea',
    source: 'mcp',
    pipeline_status: 'complete',
    brain_view: 'technical',
    created_at: '2026-04-19T09:00:00Z',
    entities: ['Open Brain', 'Research'],
  },
  {
    id: 'c7',
    title: 'London office budget memo — sign-off needed',
    snippet: 'Sarah trimmed the March draft by 12% — needs response before Thursday board',
    content: 'Sarah trimmed the March draft by 12% and needs my sign-off to pass to legal. The revised headcount is 8 FTEs in year one, down from 9. CAPEX for fit-out is £340k. The entire Thursday board deck hinges on this number being confirmed.',
    capture_type: 'task',
    source: 'email',
    pipeline_status: 'complete',
    brain_view: 'work-internal',
    created_at: '2026-04-18T10:05:00Z',
    entities: ['Sarah Chen', 'London Office', 'Budget'],
  },
  {
    id: 'c8',
    title: 'Sailing season prep — list',
    snippet: 'Antifouling, standing rigging inspection, AIS transponder upgrade',
    content: 'Antifouling done. Standing rigging — need to schedule survey before June. AIS transponder: Class B upgrade, budgeted at $600. Flares expire August — order replacements. EPIRB battery expires next January.',
    capture_type: 'task',
    source: 'voice',
    pipeline_status: 'complete',
    brain_view: 'personal',
    created_at: '2026-04-18T08:00:00Z',
    entities: ['Sailing', 'Personal'],
  },
  {
    id: 'c9',
    title: 'Observation: hiring signal from competitor',
    snippet: 'Three senior engineers from Apex posted LinkedIn updates about "new challenges"',
    content: 'Three senior engineers from Apex posted LinkedIn updates about "new challenges" in the same week. Possible team disruption. Could be an opportunity to reach out if we have open roles that fit. Platform team has two open senior IC positions.',
    capture_type: 'observation',
    source: 'slack',
    pipeline_status: 'complete',
    brain_view: 'work-internal',
    created_at: '2026-04-17T15:30:00Z',
    entities: ['Hiring', 'Platform Team'],
  },
  {
    id: 'c10',
    title: 'Q3 retrospective — key wins',
    snippet: 'Platform latency down 40%, three enterprise customers onboarded, wiki launched',
    content: 'Platform latency down 40% (p95: 180ms → 108ms). Three enterprise customers onboarded ahead of plan. Wiki launched with 11 seed articles. Maya shipped the new entity extraction pipeline. Revenue ARR up 28% vs Q2.',
    capture_type: 'win',
    source: 'api',
    pipeline_status: 'complete',
    brain_view: 'work-internal',
    created_at: '2026-04-15T16:00:00Z',
    entities: ['Q3 Retro', 'Platform Team', 'Maya Rodriguez'],
  },
];

// ---------------------------------------------------------------------------
// Timeline entries (distinct from captures — enriched for chronological view)
// ---------------------------------------------------------------------------

export const mockTimeline: TimelineEntry[] = mockCaptures.map((c) => ({
  id: c.id,
  date: c.created_at,
  capture_type: c.capture_type,
  source: c.source,
  title: c.title ?? c.content.slice(0, 60),
  snippet: c.snippet ?? c.content.slice(0, 120),
  entities: c.entities ?? [],
  pipeline_status: c.pipeline_status,
  brain_view: c.brain_view,
}));

// ---------------------------------------------------------------------------
// Entities list (Entities page)
// ---------------------------------------------------------------------------

export const mockEntities: Entity[] = [
  {
    id: 'sarah-chen',
    name: 'Sarah Chen',
    entity_type: 'person',
    mention_count: 14,
    blurb: 'VP of Operations',
    last_seen: 'Apr 18',
    trend: '▲',
    related: ['Q4 Planning', 'Hiring'],
  },
  {
    id: 'maya-rodriguez',
    name: 'Maya Rodriguez',
    entity_type: 'person',
    mention_count: 9,
    blurb: 'Senior Engineer, Platform',
    last_seen: 'Apr 20',
    trend: '▲',
    related: ['1:1', 'Career'],
  },
  {
    id: 'avi-sharma',
    name: 'Avi Sharma',
    entity_type: 'person',
    mention_count: 7,
    blurb: 'Advisor · Ventures.co',
    last_seen: 'Apr 21',
    trend: '◆',
    related: ['Advisory Board'],
  },
  {
    id: 'q4-planning',
    name: 'Q4 Planning',
    entity_type: 'project',
    mention_count: 22,
    blurb: 'Decision work-in-progress',
    last_seen: 'Apr 21',
    trend: '▲',
    related: ['Hiring', 'Budget'],
  },
  {
    id: 'platform-team',
    name: 'Platform Team',
    entity_type: 'project',
    mention_count: 6,
    blurb: 'Cross-functional squad',
    last_seen: 'Apr 21',
    trend: '▲',
    related: ['Maya Rodriguez', 'SLA'],
  },
  {
    id: 'open-brain',
    name: 'Open Brain',
    entity_type: 'project',
    mention_count: 18,
    blurb: 'This product',
    last_seen: 'Apr 20',
    trend: '◆',
    related: ['Research', 'Datasette'],
  },
  {
    id: 'hiring',
    name: 'Hiring',
    entity_type: 'topic',
    mention_count: 18,
    blurb: '18 captures over 6 weeks',
    last_seen: 'Apr 21',
    trend: '▲',
    related: ['Q4 Planning', 'Sarah Chen'],
  },
  {
    id: 'espresso',
    name: 'Espresso machine',
    entity_type: 'decision',
    mention_count: 4,
    blurb: 'Pending · due Apr 30',
    last_seen: 'Yesterday',
    trend: '◆',
    related: ['Lelit', 'ECM'],
  },
  {
    id: 'ventures',
    name: 'Ventures.co',
    entity_type: 'org',
    mention_count: 5,
    blurb: "Avi's firm",
    last_seen: 'Apr 21',
    trend: '◆',
    related: ['Avi Sharma'],
  },
  {
    id: 'fitness',
    name: 'Fitness',
    entity_type: 'topic',
    mention_count: 9,
    blurb: '9 captures',
    last_seen: '3d',
    trend: '▼',
    related: ['Personal'],
  },
  {
    id: 'book-ideas',
    name: 'Book Ideas',
    entity_type: 'topic',
    mention_count: 6,
    blurb: '6 captures',
    last_seen: '2d',
    trend: '◆',
    related: ['Writing'],
  },
  {
    id: 'ravi-shah',
    name: 'Ravi Shah',
    entity_type: 'person',
    mention_count: 3,
    blurb: 'PM · Pricing',
    last_seen: '1w',
    trend: '▼',
    related: ['Pricing'],
  },
];

/** Entity type distribution counts for the Entities sidebar */
export const mockEntityTypeCounts: Record<string, number> = {
  all: 12,
  person: 4,
  project: 3,
  topic: 3,
  org: 1,
  decision: 1,
};

/** Distribution bars for the Entities sidebar chart */
export const mockEntityDistribution: EntityDistribution[] = [
  { label: 'People',        count: 72, tone: 'var(--color-book-cloth)' },
  { label: 'Projects',      count: 38, tone: 'var(--color-slate-medium)' },
  { label: 'Topics',        count: 61, tone: 'var(--color-cloud-dark)' },
  { label: 'Organizations', count: 28, tone: 'var(--color-book-cloth-dark)' },
  { label: 'Decisions',     count: 18, tone: 'var(--color-success)' },
];

/** Needs-attention items for the Entities sidebar */
export const mockNeedsAttention: NeedsAttentionItem[] = [
  { label: 'Avi / Avi Sharma',  desc: 'Possible duplicate' },
  { label: '"the team"',         desc: 'Ambiguous reference' },
  { label: 'Q4 / Q4 Planning',  desc: 'Possible duplicate' },
];

// ---------------------------------------------------------------------------
// Entity detail — Sarah Chen fixture
// ---------------------------------------------------------------------------

export const mockSarahChen: EntityDetail = {
  id: 'sarah-chen',
  name: 'Sarah Chen',
  entity_type: 'person',
  mention_count: 148,
  blurb: 'VP of Operations',
  last_seen: 'Apr 18',
  trend: '▲',
  related: ['Q4 Planning', 'Hiring'],
  first_seen_at: '2023-08-01T00:00:00Z',
  last_seen_at: '2026-04-21T16:48:00Z',
  canonical_name: 'Sarah Chen',
  aliases: [],
  metadata: null,
  created_at: '2023-08-01T00:00:00Z',
  updated_at: '2026-04-21T16:48:00Z',
  linked_captures: [],
  co_mentioned_count: 31,
  sentiment: 'Trusted +',
  summary:
    "Sarah is driving the Q4 planning process. In the last two weeks she's pushed back on your proposed hiring timeline (twice), surfaced concerns about the London office budget, and flagged a risk around Maya's scope. She's also the one who moved finance before product on the board agenda — worth acknowledging.",
  summary_updated_at: '14m ago',
  captures: [
    {
      id: 'sc-c1',
      source: 'EMAIL',
      time: 'APR 21 · 16:48',
      title: 'Re: board agenda',
      snippet: 'Sarah suggested moving finance before product on Thursday — updated.',
    },
    {
      id: 'sc-c2',
      source: 'VOICE',
      time: 'APR 21 · 09:40',
      title: 'Dictation — investor update draft',
      snippet: '…Sarah flagged one risk I should include: the London office timeline.',
    },
    {
      id: 'sc-c3',
      source: 'MEETING',
      time: 'APR 20 · 13:10',
      title: 'Q4 planning sync',
      snippet: 'Sarah walked through the proposed headcount. Pushed back on eng ramp in December.',
    },
    {
      id: 'sc-c4',
      source: 'EMAIL',
      time: 'APR 18 · 10:05',
      title: 'London office — budget memo v3',
      snippet: 'She attached the revised budget with a 12% cut vs the March draft.',
    },
  ],
  commitments: [
    {
      who: 'Sarah owes you',
      what: 'Updated hiring timeline for engineering',
      due: 'By Thu',
      state: 'pending',
    },
    {
      who: 'You owe Sarah',
      what: 'Response on London office budget memo',
      due: 'Overdue · 2d',
      state: 'overdue',
    },
    {
      who: 'Mutually blocked',
      what: 'Decision on offer letter for H. Rahimi',
      due: 'This week',
      state: 'blocked',
    },
  ],
  related_entities: [
    { id: 'q4-planning',   name: 'Q4 Planning',   entity_type: 'project', shared_count: 22 },
    { id: 'maya-rodriguez',name: 'Maya R.',        entity_type: 'person',  shared_count: 8 },
    { id: 'london-office', name: 'London Office',  entity_type: 'project', shared_count: 6 },
    { id: 'hiring',        name: 'Hiring',         entity_type: 'topic',   shared_count: 14 },
    { id: 'board',         name: 'Board',          entity_type: 'topic',   shared_count: 5 },
    { id: 'h-rahimi',      name: 'H. Rahimi',      entity_type: 'person',  shared_count: 3 },
    { id: 'budget',        name: 'Budget',         entity_type: 'topic',   shared_count: 7 },
    { id: 'ravi-shah',     name: 'Ravi',           entity_type: 'person',  shared_count: 4 },
  ],
};

// ---------------------------------------------------------------------------
// Briefs list (Briefs page)
// ---------------------------------------------------------------------------

export const mockBriefs: Brief[] = [
  {
    id: 'tuesday',
    kind: 'DAILY',
    cover: 'parchment',
    title: 'Tuesday morning',
    subtitle: '6 items · 3 decisions pending',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-21T07:00:00.000Z',
    read_at: null,
    dismissed_at: null,
    created_at: '2026-04-21T07:00:00.000Z',
    updated_at: '2026-04-21T07:00:00.000Z',
  },
  {
    id: 'week-apr-14',
    kind: 'WEEKLY',
    cover: 'evening',
    title: 'Week of Apr 14',
    subtitle: '34 captures · 8 commitments',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-20T18:00:00.000Z',
    read_at: '2026-04-14T18:05:00.000Z',
    dismissed_at: null,
    created_at: '2026-04-20T18:00:00.000Z',
    updated_at: '2026-04-20T18:05:00.000Z',
  },
  {
    id: 'sarah-pre-1on1',
    kind: 'DOSSIER',
    cover: 'canvas',
    title: 'Sarah Chen — pre-1:1',
    subtitle: 'Before Thu 14:00',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-21T05:00:00.000Z',
    read_at: null,
    dismissed_at: null,
    created_at: '2026-04-21T05:00:00.000Z',
    updated_at: '2026-04-21T05:00:00.000Z',
  },
  {
    id: 'espresso-decision',
    kind: 'DECISION',
    cover: 'gold',
    title: 'Espresso machine',
    subtitle: 'Pros, cons, 4 candidates',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-20T12:00:00.000Z',
    read_at: null,
    dismissed_at: null,
    created_at: '2026-04-20T12:00:00.000Z',
    updated_at: '2026-04-20T12:00:00.000Z',
  },
  {
    id: 'q4-state-of',
    kind: 'PROJECT',
    cover: 'slate',
    title: 'Q4 planning — state-of',
    subtitle: '22 captures · 11 entities',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-18T08:00:00.000Z',
    read_at: '2026-04-18T09:00:00.000Z',
    dismissed_at: null,
    created_at: '2026-04-18T08:00:00.000Z',
    updated_at: '2026-04-18T09:00:00.000Z',
  },
  {
    id: 'monday',
    kind: 'DAILY',
    cover: 'parchment',
    title: 'Monday morning',
    subtitle: '4 items · 1 decision pending',
    source_skill_log_id: null,
    refined_from_id: null,
    generated_at: '2026-04-20T07:00:00.000Z',
    read_at: '2026-04-20T07:15:00.000Z',
    dismissed_at: null,
    created_at: '2026-04-20T07:00:00.000Z',
    updated_at: '2026-04-20T07:15:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Brief detail — Tuesday brief fixture
// ---------------------------------------------------------------------------

export const mockTuesdayBrief: BriefDetail = {
  id: 'tuesday',
  kind: 'DAILY',
  cover: 'parchment',
  title: 'Tuesday morning',
  subtitle: '6 items · 3 decisions pending',
  source_skill_log_id: null,
  refined_from_id: null,
  generated_at: '2026-04-21T07:00:00.000Z',
  read_at: null,
  dismissed_at: null,
  created_at: '2026-04-21T07:00:00.000Z',
  updated_at: '2026-04-21T07:00:00.000Z',
  eyebrow: 'DAILY BRIEF · TUESDAY, APRIL 21 · 07:00',
  headline: 'Three decisions are waiting on you today',
  meta: 'Drafted from 18 captures over the last 36 hours · 4 min read · Generated by Open Brain · Apr 21, 06:58',
  body_html: `
<p><span class="callout">TL;DR</span> &nbsp; The London office memo is two days overdue. Sarah has pushed back on Q4 eng hiring twice and would appreciate a 15-minute call before Thursday's board. Maya Rodriguez asked — three weeks ago — about customer exposure for her ML transition and is still waiting for a reply.</p>

<h3 id="s2">Sarah Chen pushed back — twice</h3>
<p>In your Monday 1:1 and again in an email Sunday evening, Sarah raised concerns about the December ramp in engineering headcount. She thinks the roles are "scoped too broadly" and that you're under-indexing on finance partners to support the London move.</p>
<blockquote>"I don't want to re-litigate this on Thursday — can we align before the board?" <span style="font-family: var(--font-family-monospace); font-size: 11px; color: var(--color-text-body-secondary);">— Email, Apr 20 22:14</span></blockquote>
<p>Given she moved finance before product on the agenda this morning, a short call today would land better than a written reply.</p>

<h3 id="s3">London office — 2 days overdue</h3>
<p>The budget memo v3 went out Friday. Sarah trimmed the March draft by 12% and needs your sign-off to pass to legal. You haven't replied. The entire Thursday board deck hinges on this number.</p>

<h3 id="s4">Maya on customer exposure</h3>
<p>In your last 1:1 on Apr 7, Maya asked if she could sit in on customer calls as she transitions to ML. You said "I'll think about it." Three weeks and three 1:1s later, she hasn't brought it up again — but it's in her Stanford cert notes as a blocker. Worth surfacing proactively.</p>

<h3 id="s5">Low-signal items skipped (7)</h3>
<p>Today's brief filtered out 7 items: 3 newsletter auto-summaries, 2 calendar reminders, a bookmark on espresso machines, and an already-resolved Slack thread. <a href="#" style="color: var(--color-book-cloth-dark); text-decoration: underline; text-decoration-thickness: 1px;">Show skipped →</a></p>
  `.trim(),
  toc: [
    { id: 's1', label: 'Three decisions waiting', active: true },
    { id: 's2', label: 'Sarah Chen pushed back — twice' },
    { id: 's3', label: 'London office — 2 days overdue' },
    { id: 's4', label: 'Maya on customer exposure' },
    { id: 's5', label: 'Low-signal skipped (7)' },
    { id: 's6', label: 'Sources' },
  ],
  sources: [
    { type: 'EMAIL',   title: 'Re: board agenda',            date: 'Apr 21' },
    { type: 'EMAIL',   title: 'London office — budget v3',   date: 'Apr 18' },
    { type: 'MEETING', title: '1:1 with Sarah',              date: 'Apr 20' },
    { type: 'MEETING', title: '1:1 with Maya',               date: 'Apr 7' },
    { type: 'VOICE',   title: 'Morning walk — Q4',           date: 'Apr 21' },
    { type: 'NOTE',    title: 'Agenda scratchpad',           date: 'Apr 20' },
  ],
  source_total: 18,
  refine_options: [
    '→ Shorter — just the decisions',
    '→ Longer — include skipped items',
    '→ By project instead of priority',
    '→ More direct tone',
  ],
};
