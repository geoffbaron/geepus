import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordSuccessfulPattern } from './skills';
import { retrieveContext, SKILLS_NAMESPACE } from './rag';
import { VectorStore } from './vectorStore';

describe('recordSuccessfulPattern', () => {
  let dir: string;
  let store: VectorStore;
  let skillsDir: string;
  let trackerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-skills-test-'));
    store = new VectorStore(join(dir, 'vectors'));
    skillsDir = join(dir, 'skills');
    trackerPath = join(dir, 'pattern-tracker.json');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('use local hash embeddings in tests')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('does not synthesize a skill on the first success', async () => {
    const result = await recordSuccessfulPattern('deploy the app to staging', ['run_command', 'http_get'], {
      skillsDir,
      trackerPath,
      store,
    });
    expect(result.synthesized).toBe(false);
  });

  // The exact M4 accept criterion: after two similar successful runs, a skill file exists
  // and is injected into the third run's prompt.
  it('accept criterion: synthesizes a SKILL.md on the second matching success, and it is retrievable via RAG', async () => {
    const objective = 'deploy the app to staging';
    const toolSequence = ['run_command', 'http_get'];

    const first = await recordSuccessfulPattern(objective, toolSequence, { skillsDir, trackerPath, store });
    expect(first.synthesized).toBe(false);

    const second = await recordSuccessfulPattern(objective, toolSequence, { skillsDir, trackerPath, store });
    expect(second.synthesized).toBe(true);
    expect(second.slug).toBeDefined();

    const skillFile = await readFile(join(skillsDir, second.slug!, 'SKILL.md'), 'utf8');
    expect(skillFile).toContain(objective);
    expect(skillFile).toContain('run_command');
    expect(skillFile).toContain('http_get');

    // "injected into the third run's prompt" — i.e. retrievable via RAG for a similar objective.
    const hits = await retrieveContext(store, 'deploy the app to staging', [SKILLS_NAMESPACE], { minSimilarity: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain(objective);
  });

  it('persists the pattern count across a fresh call (survives an app restart)', async () => {
    await recordSuccessfulPattern('build the docs site', ['write_file'], { skillsDir, trackerPath, store });
    // Simulate a restart: nothing in-memory carries over, only what's on disk via trackerPath.
    const result = await recordSuccessfulPattern('build the docs site', ['write_file'], { skillsDir, trackerPath, store });
    expect(result.synthesized).toBe(true);
  });

  it('does not synthesize for a run with no tool calls', async () => {
    const result = await recordSuccessfulPattern('just chatted', [], { skillsDir, trackerPath, store });
    expect(result.synthesized).toBe(false);
  });

  it('treats a different tool sequence for the same objective as a different pattern', async () => {
    await recordSuccessfulPattern('fix the failing test', ['read_file', 'write_file'], { skillsDir, trackerPath, store });
    const result = await recordSuccessfulPattern('fix the failing test', ['run_command'], { skillsDir, trackerPath, store });
    expect(result.synthesized).toBe(false);
  });

  it('redacts secrets before writing the skill file to disk', async () => {
    const objective = 'deploy with key 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';
    await recordSuccessfulPattern(objective, ['run_command'], { skillsDir, trackerPath, store });
    const result = await recordSuccessfulPattern(objective, ['run_command'], { skillsDir, trackerPath, store });
    const skillFile = await readFile(join(skillsDir, result.slug!, 'SKILL.md'), 'utf8');
    expect(skillFile).not.toContain('mWqHDSC56xLqZIgTfvEUHkJoJR6acYBSpsxUoirf4L3X7kdSLwb');
  });
});
