import { describe, expect, it } from 'vitest';
import { cronMatches, nextCronMatch, parseCron, parseInterval } from './cron';

describe('parseCron / cronMatches', () => {
  it('matches every minute for a bare "* * * * *"', () => {
    const parsed = parseCron('* * * * *');
    expect(parsed).not.toBeNull();
    expect(cronMatches(parsed!, new Date(2026, 0, 1, 13, 37))).toBe(true);
  });

  it('matches a specific time (daily 8am brief)', () => {
    const parsed = parseCron('0 8 * * *')!;
    expect(cronMatches(parsed, new Date(2026, 0, 1, 8, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 8, 1))).toBe(false);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 9, 0))).toBe(false);
  });

  it('supports comma lists', () => {
    const parsed = parseCron('0,30 * * * *')!;
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 30))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 15))).toBe(false);
  });

  it('supports ranges', () => {
    const parsed = parseCron('0 9-17 * * *')!;
    expect(cronMatches(parsed, new Date(2026, 0, 1, 9, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 17, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 18, 0))).toBe(false);
  });

  it('supports */N step syntax', () => {
    const parsed = parseCron('*/15 * * * *')!;
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 0))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 15))).toBe(true);
    expect(cronMatches(parsed, new Date(2026, 0, 1, 5, 20))).toBe(false);
  });

  it('supports day-of-week (weekdays only)', () => {
    const parsed = parseCron('0 9 * * 1-5')!;
    expect(cronMatches(parsed, new Date(2026, 0, 5, 9, 0))).toBe(true); // Monday
    expect(cronMatches(parsed, new Date(2026, 0, 4, 9, 0))).toBe(false); // Sunday
  });

  it('returns null for a malformed expression', () => {
    expect(parseCron('not a cron')).toBeNull();
    expect(parseCron('* * *')).toBeNull();
  });
});

describe('parseInterval', () => {
  it.each([
    ['every 30m', 30 * 60 * 1000],
    ['every 30 min', 30 * 60 * 1000],
    ['every 2h', 2 * 60 * 60 * 1000],
    ['every 2 hours', 2 * 60 * 60 * 1000],
    ['every 1d', 24 * 60 * 60 * 1000],
    ['every 1 day', 24 * 60 * 60 * 1000],
  ])('%s -> %dms', (expr, expected) => {
    expect(parseInterval(expr)).toBe(expected);
  });

  it('returns 0 for a non-interval string', () => {
    expect(parseInterval('0 8 * * *')).toBe(0);
    expect(parseInterval('loop')).toBe(0);
  });
});

describe('nextCronMatch', () => {
  it('finds the next occurrence forward in time', () => {
    const from = new Date(2026, 0, 1, 8, 30);
    const next = nextCronMatch('0 8 * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(2); // tomorrow's 8am
    expect(next!.getHours()).toBe(8);
    expect(next!.getMinutes()).toBe(0);
  });

  it('returns null for a malformed expression', () => {
    expect(nextCronMatch('garbage', new Date())).toBeNull();
  });

  it('never returns a time at or before "from"', () => {
    const from = new Date(2026, 0, 1, 8, 0, 30); // just after 8:00:00
    const next = nextCronMatch('0 8 * * *', from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});
