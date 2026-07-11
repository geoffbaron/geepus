import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriggerEngine, filenameMatchesPattern } from './triggers';

describe('filenameMatchesPattern', () => {
  it('matches everything for "*"', () => {
    expect(filenameMatchesPattern('anything.txt', '*')).toBe(true);
  });

  it('matches a simple glob', () => {
    expect(filenameMatchesPattern('report.pdf', '*.pdf')).toBe(true);
    expect(filenameMatchesPattern('report.txt', '*.pdf')).toBe(false);
  });

  it('matches an exact filename', () => {
    expect(filenameMatchesPattern('data.csv', 'data.csv')).toBe(true);
    expect(filenameMatchesPattern('other.csv', 'data.csv')).toBe(false);
  });

  it('supports ** for nested paths', () => {
    expect(filenameMatchesPattern('a/b/c.txt', '**/*.txt')).toBe(true);
  });
});

describe('TriggerEngine', () => {
  let dir: string;
  let watchDir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-triggers-test-'));
    watchDir = join(dir, 'watched');
    await import('node:fs/promises').then((fs) => fs.mkdir(watchDir, { recursive: true }));
    filePath = join(dir, 'triggers.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function context(overrides: { isTaskRunning?: () => boolean } = {}) {
    return {
      isTaskRunning: overrides.isTaskRunning ?? (() => false),
      runTaskNow: vi.fn().mockResolvedValue(undefined),
      onFired: vi.fn(),
    };
  }

  describe('CRUD', () => {
    it('adds a trigger', async () => {
      const engine = new TriggerEngine(filePath, context());
      const trigger = await engine.add({ watchPath: watchDir, taskId: 'task1' });
      expect(trigger.id).toBeDefined();
      expect(engine.list()).toHaveLength(1);
    });

    it('rejects a trigger with no watchPath', async () => {
      const engine = new TriggerEngine(filePath, context());
      await expect(engine.add({ watchPath: '', taskId: 'task1' })).rejects.toThrow(/watchPath/i);
    });

    it('rejects a trigger with no taskId', async () => {
      const engine = new TriggerEngine(filePath, context());
      await expect(engine.add({ watchPath: watchDir, taskId: '' })).rejects.toThrow(/taskId/i);
    });

    it('updates and removes a trigger', async () => {
      const engine = new TriggerEngine(filePath, context());
      const trigger = await engine.add({ watchPath: watchDir, taskId: 'task1' });
      const updated = await engine.update(trigger.id, { pattern: '*.pdf' });
      expect(updated.pattern).toBe('*.pdf');
      await engine.remove(trigger.id);
      expect(engine.list()).toHaveLength(0);
    });

    it('persists across a fresh instance', async () => {
      const engine1 = new TriggerEngine(filePath, context());
      await engine1.add({ name: 'persisted', watchPath: watchDir, taskId: 'task1' });

      const engine2 = new TriggerEngine(filePath, context());
      await engine2.load();
      expect(engine2.list()).toHaveLength(1);
      expect(engine2.list()[0]?.name).toBe('persisted');
    });
  });

  describe('fire', () => {
    it('invokes runTaskNow and records lastFiredAt/firedCount', async () => {
      const ctx = context();
      const engine = new TriggerEngine(filePath, ctx);
      const trigger = await engine.add({ watchPath: watchDir, taskId: 'task1', cooldownMs: 0 });

      await engine.fire(trigger);
      expect(ctx.runTaskNow).toHaveBeenCalledWith('task1');
      expect(ctx.onFired).toHaveBeenCalledOnce();
      expect(trigger.firedCount).toBe(1);
    });

    it('respects the cooldown window', async () => {
      const ctx = context();
      const engine = new TriggerEngine(filePath, ctx);
      const trigger = await engine.add({ watchPath: watchDir, taskId: 'task1', cooldownMs: 60_000 });

      await engine.fire(trigger);
      await engine.fire(trigger); // still within cooldown
      expect(ctx.runTaskNow).toHaveBeenCalledOnce();
    });

    it('does not fire if the linked task is already running', async () => {
      const ctx = context({ isTaskRunning: () => true });
      const engine = new TriggerEngine(filePath, ctx);
      const trigger = await engine.add({ watchPath: watchDir, taskId: 'task1' });

      await engine.fire(trigger);
      expect(ctx.runTaskNow).not.toHaveBeenCalled();
    });
  });

  // Real filesystem watch, not mocked — proves the debounce+fire pipeline actually
  // responds to a genuine file-create event, end to end.
  describe('real filesystem watching', () => {
    it('fires when a matching file is created in the watched directory', async () => {
      const ctx = context();
      const engine = new TriggerEngine(filePath, ctx);
      await engine.add({ watchPath: watchDir, taskId: 'task1', pattern: '*.txt', cooldownMs: 0 });
      await engine.start();

      await writeFile(join(watchDir, 'new-file.txt'), 'hello');

      // Debounce is 3s; poll with real headroom above that for the fire to land even
      // under a loaded test run (this flaked once at a 5s deadline under load).
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && !ctx.runTaskNow.mock.calls.length) {
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(ctx.runTaskNow).toHaveBeenCalledWith('task1');
      engine.stopAll();
    }, 20_000);

    it('does not fire for a non-matching file', async () => {
      const ctx = context();
      const engine = new TriggerEngine(filePath, ctx);
      await engine.add({ watchPath: watchDir, taskId: 'task1', pattern: '*.pdf', cooldownMs: 0 });
      await engine.start();

      await writeFile(join(watchDir, 'irrelevant.txt'), 'hello');
      await new Promise((r) => setTimeout(r, 3500));

      expect(ctx.runTaskNow).not.toHaveBeenCalled();
      engine.stopAll();
    }, 10_000);
  });
});
