import { describe, expect, it } from 'vitest';
import { recommendForMachine } from './recommend';
import type { MachineProfile } from '@shared/setup';

function profile(ramGb: number): MachineProfile {
  return { chip: 'test', arch: 'arm64', ramGb, freeDiskGb: 100, osVersion: 'macOS 26', tier: 'good' };
}

describe('recommendForMachine', () => {
  it('delegates to the catalog for the chat model based on RAM', () => {
    expect(recommendForMachine(profile(16)).chatModel?.ollamaTag).toBe('llama3.1:8b');
  });

  it('always includes an embedding model recommendation', () => {
    expect(recommendForMachine(profile(16)).embeddingModel.embedding).toBe(true);
  });

  it('returns null chat model under the minimum supported RAM', () => {
    expect(recommendForMachine(profile(4)).chatModel).toBeNull();
  });
});
