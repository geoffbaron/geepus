import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { macOsVersionFromDarwinRelease, probeHardware } from './hardware';

describe('macOsVersionFromDarwinRelease', () => {
  it.each([
    ['20.6.0', 'macOS 11'],
    ['21.6.0', 'macOS 12'],
    ['22.6.0', 'macOS 13'],
    ['23.6.0', 'macOS 14'],
    ['24.6.0', 'macOS 15'],
    ['25.5.0', 'macOS 26'],
    ['26.0.0', 'macOS 27'],
  ])('Darwin %s -> %s', (release, expected) => {
    expect(macOsVersionFromDarwinRelease(release)).toBe(expected);
  });
});

describe('probeHardware', () => {
  it('returns plausible real values for this machine', async () => {
    const profile = await probeHardware(tmpdir());
    expect(profile.ramGb).toBeGreaterThan(0);
    expect(profile.freeDiskGb).toBeGreaterThan(0);
    expect(profile.arch).toMatch(/arm64|x64/);
    expect(profile.chip.length).toBeGreaterThan(0);
    expect(['minimal', 'basic', 'good', 'great', 'monster']).toContain(profile.tier);
  });
});
