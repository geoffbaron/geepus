'use strict';

/**
 * triggers.js — File-watch and event-based trigger engine.
 *
 * Monitors directories for changes and fires associated scheduled tasks
 * when matching files are created or modified. Supports glob-pattern matching.
 *
 * Depends on: scheduler.js, notifications.js, audit.js
 */

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const { appendAuditEvent } = require('./audit');
const { getScheduledTask, runScheduledTaskNow } = require('./scheduler');
const { notifyTriggerFired } = require('./notifications');

const MAX_WATCHERS = 20;
const DEBOUNCE_MS = 3000;
const TRIGGERS_FILE = 'triggers.json';

let triggers = [];
let watchers = new Map(); // triggerId -> FSWatcher
let debounceTimers = new Map(); // triggerId -> timeout

function triggersPath() {
  return path.join(app.getPath('userData'), TRIGGERS_FILE);
}

async function saveTriggersToDisk() {
  const file = triggersPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(triggers, null, 2), { mode: 0o600 });
}

async function loadTriggersFromDisk() {
  try {
    const raw = await fs.readFile(triggersPath(), 'utf8');
    const parsed = JSON.parse(raw);
    triggers = Array.isArray(parsed) ? parsed.map(normalizeTrigger) : [];
  } catch {
    triggers = [];
  }
  return listTriggers();
}

// ---------------------------------------------------------------------------
// Trigger schema
// ---------------------------------------------------------------------------

function makeTriggerId() {
  return `trig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTrigger(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(t.id || makeTriggerId()),
    name: String(t.name || 'Untitled trigger'),
    type: t.type === 'file_watch' ? 'file_watch' : 'file_watch', // extensible later
    watchPath: String(t.watchPath || ''),
    pattern: String(t.pattern || '*'),  // glob-ish pattern for matching filenames
    taskId: String(t.taskId || ''),     // ID of scheduled task to fire
    enabled: t.enabled !== false,
    lastFiredAt: t.lastFiredAt || null,
    firedCount: Number(t.firedCount) || 0,
    cooldownMs: Number(t.cooldownMs) || 60_000, // minimum ms between fires
    createdAt: t.createdAt || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Glob-ish pattern matching (simple: supports * and **)
// ---------------------------------------------------------------------------

function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function filenameMatchesPattern(filename, pattern) {
  if (!pattern || pattern === '*') return true;
  return patternToRegex(pattern).test(filename);
}

// ---------------------------------------------------------------------------
// File watcher management
// ---------------------------------------------------------------------------

function startWatcher(trigger) {
  if (watchers.has(trigger.id)) return;
  if (watchers.size >= MAX_WATCHERS) return;
  if (!trigger.watchPath || !trigger.enabled) return;

  const watchDir = trigger.watchPath;
  try {
    fsSync.accessSync(watchDir, fsSync.constants.R_OK);
  } catch {
    return; // path not accessible, skip silently
  }

  try {
    const watcher = fsSync.watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      if (!filenameMatchesPattern(filename, trigger.pattern)) return;
      debouncedFire(trigger, filename);
    });

    watcher.on('error', () => {
      stopWatcher(trigger.id);
    });

    watchers.set(trigger.id, watcher);
  } catch {
    // Directory may not exist or not be watchable
  }
}

function stopWatcher(triggerId) {
  const watcher = watchers.get(triggerId);
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watchers.delete(triggerId);
  }
  const timer = debounceTimers.get(triggerId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(triggerId);
  }
}

function debouncedFire(trigger, filename) {
  const existing = debounceTimers.get(trigger.id);
  if (existing) {
    clearTimeout(existing);
  }
  debounceTimers.set(trigger.id, setTimeout(() => {
    debounceTimers.delete(trigger.id);
    fireTrigger(trigger, filename).catch(() => {});
  }, DEBOUNCE_MS));
}

async function fireTrigger(trigger, filename) {
  // Cooldown check
  if (trigger.lastFiredAt) {
    const elapsed = Date.now() - new Date(trigger.lastFiredAt).getTime();
    if (elapsed < trigger.cooldownMs) return;
  }

  const task = getScheduledTask(trigger.taskId);
  if (!task) return;
  if (task.lastRunState === 'running') return;

  trigger.lastFiredAt = new Date().toISOString();
  trigger.firedCount += 1;
  await saveTriggersToDisk().catch(() => {});

  notifyTriggerFired(trigger.name, task.name);

  await appendAuditEvent({
    type: 'trigger_fired',
    trigger_id: trigger.id,
    trigger_name: trigger.name,
    task_id: task.id,
    task_name: task.name,
    filename: String(filename || ''),
  });

  try {
    await runScheduledTaskNow(trigger.taskId);
  } catch (error) {
    await appendAuditEvent({
      type: 'trigger_task_failed',
      trigger_id: trigger.id,
      error: String(error.message || error).slice(0, 500),
    });
  }
}

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

async function addTrigger(triggerDef) {
  const trigger = normalizeTrigger({ ...triggerDef, id: makeTriggerId() });
  if (!trigger.watchPath) throw new Error('Trigger needs a watchPath.');
  if (!trigger.taskId) throw new Error('Trigger needs a taskId linking to a scheduled task.');
  triggers.push(trigger);
  if (trigger.enabled) {
    startWatcher(trigger);
  }
  await saveTriggersToDisk();
  return trigger;
}

async function updateTrigger(triggerId, patch) {
  const index = triggers.findIndex((t) => t.id === triggerId);
  if (index === -1) throw new Error(`Trigger "${triggerId}" not found.`);
  const current = triggers[index];
  stopWatcher(triggerId);
  const updated = normalizeTrigger({ ...current, ...patch, id: current.id, createdAt: current.createdAt });
  triggers[index] = updated;
  if (updated.enabled) {
    startWatcher(updated);
  }
  await saveTriggersToDisk();
  return updated;
}

async function removeTrigger(triggerId) {
  const index = triggers.findIndex((t) => t.id === triggerId);
  if (index === -1) throw new Error(`Trigger "${triggerId}" not found.`);
  stopWatcher(triggerId);
  const removed = triggers.splice(index, 1)[0];
  await saveTriggersToDisk();
  return removed;
}

function listTriggers() {
  return triggers.map((t) => ({ ...t }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startAllWatchers() {
  for (const trigger of triggers) {
    if (trigger.enabled) {
      startWatcher(trigger);
    }
  }
}

function stopAllWatchers() {
  for (const [id] of watchers) {
    stopWatcher(id);
  }
}

async function initTriggers() {
  stopAllWatchers();
  await loadTriggersFromDisk();
  startAllWatchers();
  return listTriggers();
}

/**
 * Initialize triggers from an array (legacy path).
 */
function loadTriggers(triggerArray) {
  stopAllWatchers();
  triggers = Array.isArray(triggerArray) ? triggerArray.map(normalizeTrigger) : [];
  startAllWatchers();
}

/**
 * Return raw trigger array for persistence.
 */
function serializeTriggers() {
  return triggers.map((t) => ({ ...t }));
}

module.exports = {
  normalizeTrigger,
  filenameMatchesPattern,
  addTrigger,
  updateTrigger,
  removeTrigger,
  listTriggers,
  loadTriggers,
  serializeTriggers,
  initTriggers,
  loadTriggersFromDisk,
  saveTriggersToDisk,
  startAllWatchers,
  stopAllWatchers,
};
