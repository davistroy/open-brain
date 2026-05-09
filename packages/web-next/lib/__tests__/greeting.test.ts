import { describe, it, expect } from 'vitest';
import { getGreeting } from '../greeting';

/** Helper: create a Date whose getHours() returns `h`. */
function dateAt(h: number): Date {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d;
}

describe('getGreeting', () => {
  describe.each([
    // [hour, expected]
    [0,  'Good morning'],  // midnight
    [5,  'Good morning'],  // early morning
    [6,  'Good morning'],  // morning boundary start
    [11, 'Good morning'],  // just before noon
    [12, 'Good afternoon'], // noon boundary
    [16, 'Good afternoon'], // late afternoon
    [17, 'Good evening'],  // evening boundary start
    [23, 'Good evening'],  // late night
  ])('hour %i', (h, expected) => {
    it(`returns "${expected}"`, () => {
      expect(getGreeting(dateAt(h))).toBe(expected);
    });
  });

  it('uses current time when no argument is passed', () => {
    const result = getGreeting();
    expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(result);
  });
});
