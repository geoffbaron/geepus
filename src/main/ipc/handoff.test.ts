import { describe, expect, it } from 'vitest';
import { buildMailtoUrl, isGeepusEventFile } from './handoff';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildMailtoUrl', () => {
  // Regression: found live — the first version used URLSearchParams, which encodes spaces
  // as "+" (application/x-www-form-urlencoded). RFC 6068 mailto: components need plain
  // percent-encoding (%20), and Apple Mail rendered literal "+" characters in the draft
  // ("Kitchen+sink+leak", "Hi+Mike,...") instead of spaces.
  it('encodes spaces as %20, not +', () => {
    const url = buildMailtoUrl('mike@example.com', 'Kitchen sink leak', 'Hi Mike, the sink is leaking.');
    expect(url).not.toContain('+');
    expect(url).toContain('subject=Kitchen%20sink%20leak');
    expect(url).toContain('body=Hi%20Mike%2C%20the%20sink%20is%20leaking.');
  });

  it('encodes newlines as %0A', () => {
    const url = buildMailtoUrl(undefined, 'Subject', 'Line one\nLine two');
    expect(url).toContain('body=Line%20one%0ALine%20two');
  });

  it('omits the query string entirely when subject and body are both empty', () => {
    expect(buildMailtoUrl('mike@example.com', '', '')).toBe('mailto:mike%40example.com');
  });

  it('produces a bare "mailto:" with no target when `to` is omitted', () => {
    const url = buildMailtoUrl(undefined, 'Subject', 'Body');
    expect(url.startsWith('mailto:?')).toBe(true);
  });

  it('percent-encodes special characters in the recipient address', () => {
    const url = buildMailtoUrl('a+tag@example.com', 'Hi', 'Hi');
    expect(url).toContain('mailto:a%2Btag%40example.com');
  });
});

describe('isGeepusEventFile', () => {
  const validPath = join(tmpdir(), 'geepus-event-1234567890-abcd1234.ics');

  it('accepts a correctly-shaped path inside the OS temp dir', () => {
    expect(isGeepusEventFile(validPath)).toBe(true);
  });

  it('rejects a path outside the temp dir even with the right filename shape', () => {
    expect(isGeepusEventFile('/Applications/Some.app')).toBe(false);
  });

  it('rejects a temp-dir path with the wrong filename shape (defense against path confusion)', () => {
    expect(isGeepusEventFile(join(tmpdir(), 'not-a-geepus-file.ics'))).toBe(false);
    expect(isGeepusEventFile(join(tmpdir(), 'geepus-event-123.ics'))).toBe(false);
  });

  it('rejects a non-.ics file even with a plausible-looking name', () => {
    expect(isGeepusEventFile(join(tmpdir(), 'geepus-event-1234567890-abcd1234.sh'))).toBe(false);
  });
});
