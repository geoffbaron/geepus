import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRelevantStrategies, listAllStrategies, recordStrategyOutcome } from './strategies';
import { VectorStore } from './vectorStore';

describe('strategies', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-strategies-test-'));
    store = new VectorStore(dir);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('use local hash embeddings in tests')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('records a new strategy with attempts=1', async () => {
    const strategy = await recordStrategyOutcome(store, 'always check the cache before hitting the network', true);
    expect(strategy.attempts).toBe(1);
    expect(strategy.successes).toBe(1);
    expect(strategy.banned).toBe(false);
  });

  it('merges a near-identical reflection into the same strategy instead of duplicating', async () => {
    await recordStrategyOutcome(store, 'always check the cache before hitting the network', true);
    const second = await recordStrategyOutcome(store, 'always check the cache before hitting the network', true);
    expect(second.attempts).toBe(2);
    expect(second.successes).toBe(2);
    expect(await listAllStrategies(store)).toHaveLength(1);
  });

  it('keeps distinct strategies separate', async () => {
    await recordStrategyOutcome(store, 'always check the cache before hitting the network', true);
    await recordStrategyOutcome(store, 'ask for clarification before deleting files', true);
    expect(await listAllStrategies(store)).toHaveLength(2);
  });

  // Regression / core requirement: PLAN.md §8 item 2 — strategies that keep failing get
  // demoted to bannedApproaches and stop being suggested.
  it('regression: demotes a repeatedly-failing strategy to banned and excludes it from retrieval', async () => {
    const text = 'retry the request immediately without backoff';
    await recordStrategyOutcome(store, text, false);
    await recordStrategyOutcome(store, text, false);
    const third = await recordStrategyOutcome(store, text, false);

    expect(third.banned).toBe(true);

    const relevant = await getRelevantStrategies(store, 'how should I retry a failed request');
    expect(relevant.some((s) => s.text === text)).toBe(false);
  });

  it('does not ban a strategy with a healthy success rate', async () => {
    const text = 'validate input before writing to disk';
    await recordStrategyOutcome(store, text, true);
    await recordStrategyOutcome(store, text, true);
    const third = await recordStrategyOutcome(store, text, false);
    expect(third.banned).toBe(false);
  });

  it('getRelevantStrategies returns strategies relevant to the objective', async () => {
    await recordStrategyOutcome(store, 'use the weather API endpoint for temperature lookups', true);
    await recordStrategyOutcome(store, 'run tests before committing code changes', true);

    const relevant = await getRelevantStrategies(store, 'what is the weather today', 5, undefined);
    expect(relevant.some((s) => s.text.includes('weather'))).toBe(true);
  });

  it('getRelevantStrategies returns nothing when the store is empty', async () => {
    expect(await getRelevantStrategies(store, 'anything')).toEqual([]);
  });
});
