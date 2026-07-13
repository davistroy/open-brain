/**
 * Component test — StatStrip (dashboard stat tiles).
 *
 * StatStrip is a pure server component that renders a DashboardStats prop.
 * The test asserts the labels, values, delta tones, and pipeline block render
 * deterministically from a fixture — a fast render-only smoke of a top tile.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DashboardStats } from '@/lib/types'
import { StatStrip } from '../StatStrip'

const stats: DashboardStats = {
  captures_7d: 137,
  captures_7d_delta: '▲ 12%',
  captures_7d_meta: '19 today',
  active_entities: 88,
  active_entities_delta: '▼ 3%',
  active_entities_meta: 'across 5 views',
  open_questions: 24,
  open_questions_delta: '▲ 2',
  open_questions_meta: '6 stale',
  briefs_in_progress: 2,
  briefs_due_meta: 'next: morning brief',
  pipeline_status: 'healthy',
  pipeline_active: 3,
  pipeline_queued: 7,
  llm_spend_usd: 12.5,
  capture_total: 1842,
  entity_total: 356,
}

describe('StatStrip', () => {
  it('renders every stat label from the fixture', () => {
    render(<StatStrip stats={stats} />)
    expect(screen.getByText('Captures / 7d')).toBeInTheDocument()
    expect(screen.getByText('Active entities')).toBeInTheDocument()
    expect(screen.getByText('Open questions')).toBeInTheDocument()
    expect(screen.getByText('Briefs in progress')).toBeInTheDocument()
    expect(screen.getByText('Pipeline')).toBeInTheDocument()
  })

  it('renders the numeric values and deltas', () => {
    render(<StatStrip stats={stats} />)
    expect(screen.getByText('137')).toBeInTheDocument()
    expect(screen.getByText('88')).toBeInTheDocument()
    expect(screen.getByText('▲ 12%')).toBeInTheDocument()
    expect(screen.getByText('▼ 3%')).toBeInTheDocument()
  })

  it('renders the pipeline block status and active/queued meta', () => {
    render(<StatStrip stats={stats} />)
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('3 active · 7 queued')).toBeInTheDocument()
  })
})
