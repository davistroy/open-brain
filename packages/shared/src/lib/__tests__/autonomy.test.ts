import { describe, it, expect } from 'vitest'
import { meetsAutonomyLevel } from '../autonomy.js'

describe('meetsAutonomyLevel', () => {
  it('observe meets observe', () => {
    expect(meetsAutonomyLevel('observe', 'observe')).toBe(true)
  })

  it('observe does not meet assist', () => {
    expect(meetsAutonomyLevel('observe', 'assist')).toBe(false)
  })

  it('assist meets observe', () => {
    expect(meetsAutonomyLevel('assist', 'observe')).toBe(true)
  })

  it('advise meets assist', () => {
    expect(meetsAutonomyLevel('advise', 'assist')).toBe(true)
  })

  it('partner meets everything', () => {
    expect(meetsAutonomyLevel('partner', 'observe')).toBe(true)
    expect(meetsAutonomyLevel('partner', 'assist')).toBe(true)
    expect(meetsAutonomyLevel('partner', 'advise')).toBe(true)
    expect(meetsAutonomyLevel('partner', 'partner')).toBe(true)
  })

  it('observe does not meet partner', () => {
    expect(meetsAutonomyLevel('observe', 'partner')).toBe(false)
  })
})
