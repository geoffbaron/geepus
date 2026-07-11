import { randomUUID } from 'node:crypto';
import { accessSync, constants, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileWatchTrigger, FileWatchTriggerInput } from '@shared/schedule';

const MAX_WATCHERS = 20;
const DEBOUNCE_MS = 3000;

function makeTriggerId(): string {
  return `trig_${randomUUID()}`;
}

function normalizeTrigger(input: Partial<FileWatchTrigger> & { watchPath: string; taskId: string }): FileWatchTrigger {
  return {
    id: input.id ?? makeTriggerId(),
    name: input.name ?? 'Untitled trigger',
    watchPath: input.watchPath,
    pattern: input.pattern ?? '*',
    taskId: input.taskId,
    enabled: input.enabled !== false,
    lastFiredAt: input.lastFiredAt ?? null,
    firedCount: input.firedCount ?? 0,
    cooldownMs: input.cooldownMs ?? 60_000,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function filenameMatchesPattern(filename: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  return patternToRegex(pattern).test(filename);
}

export interface FireTriggerContext {
  /** Looks up the linked scheduled task's current state — returns null if it doesn't exist. */
  isTaskRunning: (taskId: string) => boolean;
  runTaskNow: (taskId: string) => Promise<void>;
  onFired?: (trigger: FileWatchTrigger) => void;
}

/**
 * File-watch triggers ported from the prototype's triggers.js — fires a linked scheduled
 * task when a matching file changes, debounced and cooldown-limited.
 */
export class TriggerEngine {
  private triggers: FileWatchTrigger[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly filePath: string,
    private readonly context: FireTriggerContext,
  ) {}

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.triggers, null, 2), { mode: 0o600 });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.triggers = Array.isArray(parsed) ? parsed.map((t) => normalizeTrigger(t as FileWatchTrigger)) : [];
    } catch {
      this.triggers = [];
    }
  }

  list(): FileWatchTrigger[] {
    return this.triggers.map((t) => ({ ...t }));
  }

  private startWatcher(trigger: FileWatchTrigger): void {
    if (this.watchers.has(trigger.id)) return;
    if (this.watchers.size >= MAX_WATCHERS) return;
    if (!trigger.watchPath || !trigger.enabled) return;

    try {
      accessSync(trigger.watchPath, constants.R_OK);
    } catch {
      return; // not accessible — skip silently, matches prototype behavior
    }

    try {
      const watcher = watch(trigger.watchPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filenameMatchesPattern(String(filename), trigger.pattern)) return;
        this.debouncedFire(trigger);
      });
      watcher.on('error', () => this.stopWatcher(trigger.id));
      this.watchers.set(trigger.id, watcher);
    } catch {
      // directory may not be watchable — skip
    }
  }

  private stopWatcher(triggerId: string): void {
    this.watchers.get(triggerId)?.close();
    this.watchers.delete(triggerId);
    const timer = this.debounceTimers.get(triggerId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(triggerId);
    }
  }

  private debouncedFire(trigger: FileWatchTrigger): void {
    const existing = this.debounceTimers.get(trigger.id);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      trigger.id,
      setTimeout(() => {
        this.debounceTimers.delete(trigger.id);
        void this.fire(trigger);
      }, DEBOUNCE_MS),
    );
  }

  async fire(trigger: FileWatchTrigger): Promise<void> {
    if (trigger.lastFiredAt) {
      const elapsed = Date.now() - new Date(trigger.lastFiredAt).getTime();
      if (elapsed < trigger.cooldownMs) return;
    }
    if (this.context.isTaskRunning(trigger.taskId)) return;

    trigger.lastFiredAt = new Date().toISOString();
    trigger.firedCount += 1;
    await this.save().catch(() => {});
    this.context.onFired?.(trigger);

    await this.context.runTaskNow(trigger.taskId).catch(() => {});
  }

  async add(input: FileWatchTriggerInput): Promise<FileWatchTrigger> {
    if (!input.watchPath) throw new Error('Trigger needs a watchPath.');
    if (!input.taskId) throw new Error('Trigger needs a taskId linking to a scheduled task.');
    const trigger = normalizeTrigger(input);
    this.triggers.push(trigger);
    if (trigger.enabled) this.startWatcher(trigger);
    await this.save();
    return trigger;
  }

  async update(triggerId: string, patch: Partial<FileWatchTriggerInput>): Promise<FileWatchTrigger> {
    const index = this.triggers.findIndex((t) => t.id === triggerId);
    if (index === -1) throw new Error(`Trigger "${triggerId}" not found.`);
    const current = this.triggers[index]!;
    this.stopWatcher(triggerId);
    const updated = normalizeTrigger({ ...current, ...patch, id: current.id, createdAt: current.createdAt });
    this.triggers[index] = updated;
    if (updated.enabled) this.startWatcher(updated);
    await this.save();
    return updated;
  }

  async remove(triggerId: string): Promise<FileWatchTrigger> {
    const index = this.triggers.findIndex((t) => t.id === triggerId);
    if (index === -1) throw new Error(`Trigger "${triggerId}" not found.`);
    this.stopWatcher(triggerId);
    const [removed] = this.triggers.splice(index, 1);
    await this.save();
    return removed!;
  }

  async start(): Promise<void> {
    this.stopAll();
    await this.load();
    for (const trigger of this.triggers) {
      if (trigger.enabled) this.startWatcher(trigger);
    }
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stopWatcher(id);
  }
}
