import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { determineSetupPath, verifyMacAppSignature } from './installer';
import type { DiscoveryReport, MachineProfile } from '@shared/setup';

function profile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return { chip: 'test', arch: 'arm64', ramGb: 16, freeDiskGb: 100, osVersion: 'macOS 26', tier: 'good', ...overrides };
}

function discovery(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    runtimes: [
      { id: 'ollama', available: false, binaryFound: false, models: [] },
      { id: 'lmstudio', available: false, binaryFound: false, models: [] },
    ],
    looseFiles: [],
    ...overrides,
  };
}

describe('determineSetupPath', () => {
  it('Path D: under 8GB RAM always wins regardless of what is installed', () => {
    const plan = determineSetupPath(profile({ ramGb: 4, tier: 'minimal' }), discovery());
    expect(plan.path).toBe('D');
  });

  it('Path A: Ollama running with a model that fits', () => {
    const plan = determineSetupPath(
      profile({ ramGb: 16 }),
      discovery({
        runtimes: [
          { id: 'ollama', available: true, binaryFound: true, models: [{ name: 'llama3.2:3b', sizeGb: 2, chatCapable: true }] },
          { id: 'lmstudio', available: false, binaryFound: false, models: [] },
        ],
      }),
    );
    expect(plan.path).toBe('A');
  });

  it('Path B: Ollama running but only an embedding-only model fits — never adopted as chat driver', () => {
    const plan = determineSetupPath(
      profile({ ramGb: 16 }),
      discovery({
        runtimes: [
          {
            id: 'ollama',
            available: true,
            binaryFound: true,
            models: [{ name: 'nomic-embed-text:latest', sizeGb: 0.27, chatCapable: false }],
          },
          { id: 'lmstudio', available: false, binaryFound: false, models: [] },
        ],
      }),
    );
    expect(plan.path).toBe('B');
  });

  it('Path B: Ollama running but only oversized models installed', () => {
    const plan = determineSetupPath(
      profile({ ramGb: 16 }),
      discovery({
        runtimes: [
          { id: 'ollama', available: true, binaryFound: true, models: [{ name: 'huge:70b', sizeGb: 40, chatCapable: true }] },
          { id: 'lmstudio', available: false, binaryFound: false, models: [] },
        ],
      }),
    );
    expect(plan.path).toBe('B');
  });

  it('Path B: Ollama running with no models at all', () => {
    const plan = determineSetupPath(
      profile({ ramGb: 16 }),
      discovery({
        runtimes: [
          { id: 'ollama', available: true, binaryFound: true, models: [] },
          { id: 'lmstudio', available: false, binaryFound: false, models: [] },
        ],
      }),
    );
    expect(plan.path).toBe('B');
  });

  it('Path C: nothing detected', () => {
    const plan = determineSetupPath(profile({ ramGb: 16 }), discovery());
    expect(plan.path).toBe('C');
  });

  it('never recommends Path A/B on a sub-8GB machine even with Ollama running', () => {
    const plan = determineSetupPath(
      profile({ ramGb: 4, tier: 'minimal' }),
      discovery({
        runtimes: [
          { id: 'ollama', available: true, binaryFound: true, models: [{ name: 'tiny:1b', sizeGb: 0.7, chatCapable: true }] },
          { id: 'lmstudio', available: false, binaryFound: false, models: [] },
        ],
      }),
    );
    expect(plan.path).toBe('D');
  });
});

// Non-destructive: only reads the signature of the app already installed on this machine,
// never downloads or modifies anything (see PLAN.md safety notes for this milestone).
describe.skipIf(!existsSync('/Applications/Ollama.app'))('verifyMacAppSignature (live, read-only)', () => {
  it('accepts the real, already-installed, notarized Ollama.app', async () => {
    const result = await verifyMacAppSignature('/Applications/Ollama.app');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/accepted/);
  });

  it('rejects a path that is not a valid app bundle', async () => {
    const result = await verifyMacAppSignature('/Applications/Ollama.app/Contents/Info.plist');
    expect(result.ok).toBe(false);
  });
});
