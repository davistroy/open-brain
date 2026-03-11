import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  expandHtmlSection,
  buildFallbackHtml,
  renderEmailText,
  buildBriefText,
} from '../skills/weekly-brief-renderer.js'
import type { WeeklyBriefOutput } from '../skills/weekly-brief-query.js'

// ============================================================
// Fixtures
// ============================================================

function makeBrief(overrides: Partial<WeeklyBriefOutput> = {}): WeeklyBriefOutput {
  return {
    headline: 'Test headline for the week.',
    wins: ['Closed deal with Acme', 'Shipped feature X'],
    blockers: ['Waiting on vendor API access'],
    risks: ['Budget overrun risk on Project Y'],
    open_loops: ['Decision on team expansion'],
    next_week_focus: ['Finalize proposal', 'Deploy staging'],
    avoided_decisions: ['Whether to hire contractor'],
    drift_alerts: ['Side project untouched for 3 weeks'],
    connections: ['Budget risk connects to staffing decision'],
    ...overrides,
  }
}

const EMPTY_BRIEF: WeeklyBriefOutput = {
  headline: 'Quiet week.',
  wins: [],
  blockers: [],
  risks: [],
  open_loops: [],
  next_week_focus: [],
  avoided_decisions: [],
  drift_alerts: [],
  connections: [],
}

// ============================================================
// Tests: escapeHtml
// ============================================================

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('He said "hello"')).toBe('He said &quot;hello&quot;')
  })

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('Normal text without special chars')).toBe('Normal text without special chars')
  })
})

// ============================================================
// Tests: expandHtmlSection
// ============================================================

describe('expandHtmlSection', () => {
  const TEMPLATE = `
    {{#if wins}}
    <div class="section">
      <ul>{{#each wins}}<li>{{this}}</li>{{/each}}</ul>
    </div>
    {{/if}}
  `

  it('expands if/each blocks when items are present', () => {
    const result = expandHtmlSection(TEMPLATE, 'wins', ['Win A', 'Win B'])
    expect(result).toContain('<li>Win A</li>')
    expect(result).toContain('<li>Win B</li>')
    expect(result).toContain('<div class="section">')
  })

  it('removes entire block when items array is empty', () => {
    const result = expandHtmlSection(TEMPLATE, 'wins', [])
    expect(result.trim()).toBe('')
  })

  it('escapes HTML in items', () => {
    const result = expandHtmlSection(TEMPLATE, 'wins', ['<b>bold</b>'])
    expect(result).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(result).not.toContain('<b>bold</b>')
  })

  it('handles template with no matching field gracefully', () => {
    const result = expandHtmlSection(TEMPLATE, 'blockers', ['A blocker'])
    // Should not modify the template (no blockers block present)
    expect(result).toContain('{{#if wins}}')
  })

  it('handles multiple items correctly', () => {
    const items = ['First', 'Second', 'Third']
    const result = expandHtmlSection(TEMPLATE, 'wins', items)
    expect(result).toContain('<li>First</li>')
    expect(result).toContain('<li>Second</li>')
    expect(result).toContain('<li>Third</li>')
  })
})

// ============================================================
// Tests: buildFallbackHtml
// ============================================================

describe('buildFallbackHtml', () => {
  it('includes headline', () => {
    const html = buildFallbackHtml(makeBrief(), '2026-03-01', '2026-03-07', 42)
    expect(html).toContain('Test headline for the week.')
  })

  it('includes date range and capture count', () => {
    const html = buildFallbackHtml(makeBrief(), '2026-03-01', '2026-03-07', 42)
    expect(html).toContain('2026-03-01')
    expect(html).toContain('2026-03-07')
    expect(html).toContain('42 captures')
  })

  it('includes all populated sections as h3 + ul', () => {
    const html = buildFallbackHtml(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(html).toContain('<h3>Wins</h3>')
    expect(html).toContain('<h3>Blockers</h3>')
    expect(html).toContain('<h3>Risks</h3>')
    expect(html).toContain('<h3>Open Loops</h3>')
    expect(html).toContain('<h3>Next Week Focus</h3>')
    expect(html).toContain('<h3>Decisions Avoided</h3>')
    expect(html).toContain('<h3>Drift Alerts</h3>')
    expect(html).toContain('<h3>Connections</h3>')
  })

  it('renders list items for each entry', () => {
    const html = buildFallbackHtml(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(html).toContain('<li>Closed deal with Acme</li>')
    expect(html).toContain('<li>Shipped feature X</li>')
  })

  it('omits empty sections', () => {
    const html = buildFallbackHtml(EMPTY_BRIEF, '2026-03-01', '2026-03-07', 0)
    expect(html).not.toContain('<h3>Wins</h3>')
    expect(html).not.toContain('<h3>Blockers</h3>')
    expect(html).toContain('Quiet week.')
  })

  it('escapes HTML in headline', () => {
    const brief = makeBrief({ headline: '<script>alert("xss")</script>' })
    const html = buildFallbackHtml(brief, '2026-03-01', '2026-03-07', 1)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes HTML in list items', () => {
    const brief = makeBrief({ wins: ['Achieved <100ms latency'] })
    const html = buildFallbackHtml(brief, '2026-03-01', '2026-03-07', 1)
    expect(html).toContain('&lt;100ms')
  })

  it('produces valid HTML structure', () => {
    const html = buildFallbackHtml(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html>')
    expect(html).toContain('</html>')
    expect(html).toContain('Generated by Open Brain')
  })
})

// ============================================================
// Tests: renderEmailText
// ============================================================

describe('renderEmailText', () => {
  it('includes header with date range and count', () => {
    const text = renderEmailText(makeBrief(), '2026-03-01', '2026-03-07', 42)
    expect(text).toContain('OPEN BRAIN — WEEKLY BRIEF')
    expect(text).toContain('Week of 2026-03-01 to 2026-03-07')
    expect(text).toContain('42 captures')
  })

  it('includes headline', () => {
    const text = renderEmailText(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(text).toContain('HEADLINE')
    expect(text).toContain('Test headline for the week.')
  })

  it('renders populated sections with bullet points', () => {
    const text = renderEmailText(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(text).toContain('WINS')
    expect(text).toContain('  - Closed deal with Acme')
    expect(text).toContain('  - Shipped feature X')
    expect(text).toContain('BLOCKERS')
    expect(text).toContain('  - Waiting on vendor API access')
  })

  it('omits empty sections', () => {
    const text = renderEmailText(EMPTY_BRIEF, '2026-03-01', '2026-03-07', 0)
    expect(text).not.toContain('WINS')
    expect(text).not.toContain('BLOCKERS')
    expect(text).toContain('HEADLINE')
  })

  it('ends with the footer text', () => {
    const text = renderEmailText(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(text).toContain('Generated by Open Brain')
  })

  it('renders all 8 section types when populated', () => {
    const text = renderEmailText(makeBrief(), '2026-03-01', '2026-03-07', 10)
    expect(text).toContain('WINS')
    expect(text).toContain('BLOCKERS')
    expect(text).toContain('RISKS')
    expect(text).toContain('OPEN LOOPS')
    expect(text).toContain('NEXT WEEK FOCUS')
    expect(text).toContain('DECISIONS AVOIDED')
    expect(text).toContain('DRIFT ALERTS')
    expect(text).toContain('CONNECTIONS')
  })
})

// ============================================================
// Tests: buildBriefText
// ============================================================

describe('buildBriefText', () => {
  it('includes title with date range', () => {
    const text = buildBriefText(makeBrief(), '2026-03-01', '2026-03-07')
    expect(text).toContain('Weekly Brief — 2026-03-01 to 2026-03-07')
  })

  it('includes headline', () => {
    const text = buildBriefText(makeBrief(), '2026-03-01', '2026-03-07')
    expect(text).toContain('Test headline for the week.')
  })

  it('renders sections with label and dash-prefixed items', () => {
    const text = buildBriefText(makeBrief(), '2026-03-01', '2026-03-07')
    expect(text).toContain('Wins:')
    expect(text).toContain('- Closed deal with Acme')
    expect(text).toContain('Blockers:')
    expect(text).toContain('- Waiting on vendor API access')
  })

  it('omits empty sections', () => {
    const text = buildBriefText(EMPTY_BRIEF, '2026-03-01', '2026-03-07')
    expect(text).not.toContain('Wins:')
    expect(text).not.toContain('Blockers:')
  })

  it('trims trailing whitespace', () => {
    const text = buildBriefText(makeBrief(), '2026-03-01', '2026-03-07')
    expect(text).toBe(text.trim())
  })
})
