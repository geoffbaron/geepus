'use strict';

/**
 * token-tracker.js — Token usage tracking, cost estimation, and daily cost log persistence.
 *
 * Captures input/output tokens from each LLM API call, estimates cost based on
 * known model pricing, persists per-run and daily aggregate data to JSON files
 * under userData/costs/.
 *
 * Pricing source: approximate public pricing as of early 2026.
 * Users can override via settings.customModelPricing.
 */

const path = require('path');
const fs = require('fs/promises');
const { app } = require('electron');

// ---------------------------------------------------------------------------
// Pricing table — USD per 1M tokens { input, output }
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
  // OpenAI
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60 },
  'gpt-4o-2024-11-20':  { input: 2.50,  output: 10.00 },
  'gpt-4.1':            { input: 2.00,  output: 8.00 },
  'gpt-4.1-mini':       { input: 0.40,  output: 1.60 },
  'gpt-4.1-nano':       { input: 0.10,  output: 0.40 },
  'gpt-4-turbo':        { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':      { input: 0.50,  output: 1.50 },
  'o1':                 { input: 15.00, output: 60.00 },
  'o1-mini':            { input: 3.00,  output: 12.00 },
  'o1-pro':             { input: 150.00, output: 600.00 },
  'o3':                 { input: 10.00, output: 40.00 },
  'o3-mini':            { input: 1.10,  output: 4.40 },
  'o4-mini':            { input: 1.10,  output: 4.40 },

  // Anthropic
  'claude-3-opus-20240229':   { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229': { input: 3.00,  output: 15.00 },
  'claude-3-haiku-20240307':  { input: 0.25,  output: 1.25 },
  'claude-3.5-sonnet':        { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 1.00, output: 5.00 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function costsDir() {
  return path.join(app.getPath('userData'), 'costs');
}

function dailyLogPath(dateStr) {
  return path.join(costsDir(), `${dateStr}.json`);
}

function runCostPath(runId) {
  return path.join(costsDir(), 'runs', `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a model. Checks exact match first, then prefix match.
 * Returns { input, output } per 1M tokens, or null if unknown.
 */
function lookupModelPricing(model, customPricing = {}) {
  const name = String(model || '').trim().toLowerCase();
  if (!name) return null;

  // Custom pricing takes precedence
  if (customPricing[name]) return customPricing[name];
  if (MODEL_PRICING[name]) return MODEL_PRICING[name];

  // Prefix match for versioned models (e.g. gpt-4o-2024-xx → gpt-4o)
  for (const [key, pricing] of Object.entries({ ...customPricing, ...MODEL_PRICING })) {
    if (name.startsWith(key) || key.startsWith(name)) {
      return pricing;
    }
  }
  return null;
}

/**
 * Estimate cost in USD for a single API call.
 */
function estimateCost(model, inputTokens, outputTokens, customPricing = {}) {
  const pricing = lookupModelPricing(model, customPricing);
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

// ---------------------------------------------------------------------------
// Usage extraction from API payloads
// ---------------------------------------------------------------------------

/**
 * Extract token counts from an API response payload.
 * Works for both OpenAI Responses API and Anthropic Messages API.
 *
 * OpenAI:    { usage: { input_tokens, output_tokens, total_tokens } }
 * Anthropic: { usage: { input_tokens, output_tokens } }
 */
function extractUsageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = payload.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0),
  };
}

// ---------------------------------------------------------------------------
// In-memory per-run accumulator
// ---------------------------------------------------------------------------

const runAccumulators = new Map();

/**
 * Record a single API call's usage for a run.
 */
function recordUsage(runId, model, inputTokens, outputTokens, customPricing = {}) {
  if (!runId) return;

  if (!runAccumulators.has(runId)) {
    runAccumulators.set(runId, {
      runId,
      startedAt: new Date().toISOString(),
      calls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      byModel: {},
    });
  }

  const acc = runAccumulators.get(runId);
  const cost = estimateCost(model, inputTokens, outputTokens, customPricing);

  acc.calls += 1;
  acc.totalInputTokens += inputTokens;
  acc.totalOutputTokens += outputTokens;
  acc.totalCost += cost;

  if (!acc.byModel[model]) {
    acc.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  const modelAcc = acc.byModel[model];
  modelAcc.calls += 1;
  modelAcc.inputTokens += inputTokens;
  modelAcc.outputTokens += outputTokens;
  modelAcc.cost += cost;

  return acc;
}

/**
 * Get current usage for a run (or empty).
 */
function getRunUsage(runId) {
  return runAccumulators.get(runId) || null;
}

/**
 * Clear in-memory accumulator for a run (called after persisting).
 */
function clearRunAccumulator(runId) {
  runAccumulators.delete(runId);
}

/**
 * Restore the in-memory accumulator from the persisted per-run cost file.
 * Called on run resume so that the budget enforcement sees prior spend.
 * Returns the restored accumulator or null if no prior data exists.
 */
async function restoreRunAccumulator(runId) {
  if (!runId) return null;
  // Already in memory — nothing to restore
  if (runAccumulators.has(runId)) return runAccumulators.get(runId);
  try {
    const content = await fs.readFile(runCostPath(runId), 'utf8');
    const data = JSON.parse(content);
    const acc = {
      runId,
      startedAt: data.startedAt || new Date().toISOString(),
      calls: Number(data.calls || 0),
      totalInputTokens: Number(data.totalInputTokens || 0),
      totalOutputTokens: Number(data.totalOutputTokens || 0),
      totalCost: Number(data.totalCost || 0),
      byModel: data.byModel || {},
    };
    runAccumulators.set(runId, acc);
    return acc;
  } catch {
    // No persisted file — first run or never persisted
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence — per-run cost file
// ---------------------------------------------------------------------------

async function persistRunCost(runId) {
  const acc = runAccumulators.get(runId);
  if (!acc) return null;

  const data = {
    ...acc,
    totalCost: Math.round(acc.totalCost * 1_000_000) / 1_000_000,
    finishedAt: new Date().toISOString(),
  };

  const filePath = runCostPath(runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// ---------------------------------------------------------------------------
// Persistence — daily aggregate log
// ---------------------------------------------------------------------------

async function readDailyLog(dateStr) {
  try {
    const content = await fs.readFile(dailyLogPath(dateStr), 'utf8');
    return JSON.parse(content);
  } catch {
    return {
      date: dateStr,
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      runs: [],
    };
  }
}

async function appendToDailyLog(runId) {
  const acc = runAccumulators.get(runId);
  if (!acc) return;

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const log = await readDailyLog(dateStr);

  log.totalCalls += acc.calls;
  log.totalInputTokens += acc.totalInputTokens;
  log.totalOutputTokens += acc.totalOutputTokens;
  log.totalCost += acc.totalCost;
  log.totalCost = Math.round(log.totalCost * 1_000_000) / 1_000_000;

  // Keep a summary per run in the daily log
  const existing = log.runs.findIndex((r) => r.runId === runId);
  const runEntry = {
    runId,
    calls: acc.calls,
    inputTokens: acc.totalInputTokens,
    outputTokens: acc.totalOutputTokens,
    cost: Math.round(acc.totalCost * 1_000_000) / 1_000_000,
    finishedAt: new Date().toISOString(),
  };
  if (existing >= 0) {
    // Update instead of duplicating
    log.totalCalls -= log.runs[existing].calls;
    log.totalInputTokens -= log.runs[existing].inputTokens;
    log.totalOutputTokens -= log.runs[existing].outputTokens;
    log.totalCost -= log.runs[existing].cost;
    log.totalCost = Math.round((log.totalCost + acc.totalCost) * 1_000_000) / 1_000_000;
    log.runs[existing] = runEntry;
  } else {
    log.runs.push(runEntry);
  }

  await fs.mkdir(costsDir(), { recursive: true });
  await fs.writeFile(dailyLogPath(dateStr), JSON.stringify(log, null, 2), 'utf8');
}

/**
 * Finalize a run's cost tracking: persist per-run file, append to daily log, clear accumulator.
 */
async function finalizeRunCost(runId) {
  if (!runAccumulators.has(runId)) return null;

  const [data] = await Promise.all([
    persistRunCost(runId),
    appendToDailyLog(runId),
  ]);
  clearRunAccumulator(runId);
  return data;
}

// ---------------------------------------------------------------------------
// Dashboard data queries
// ---------------------------------------------------------------------------

/**
 * Get cost summary for the last N days (default 30).
 */
async function getCostSummary(days = 30) {
  const results = [];
  const now = new Date();
  let grandTotal = 0;
  let grandCalls = 0;
  let grandInput = 0;
  let grandOutput = 0;

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const log = await readDailyLog(dateStr);
    if (log.totalCalls > 0) {
      results.push({
        date: dateStr,
        calls: log.totalCalls,
        inputTokens: log.totalInputTokens,
        outputTokens: log.totalOutputTokens,
        cost: log.totalCost,
      });
    }
    grandTotal += log.totalCost;
    grandCalls += log.totalCalls;
    grandInput += log.totalInputTokens;
    grandOutput += log.totalOutputTokens;
  }

  return {
    period: `Last ${days} days`,
    days: results,
    totals: {
      calls: grandCalls,
      inputTokens: grandInput,
      outputTokens: grandOutput,
      cost: Math.round(grandTotal * 1_000_000) / 1_000_000,
    },
  };
}

/**
 * Get cost breakdown for a specific run.
 */
async function getRunCostDetails(runId) {
  // Check in-memory first (active run)
  const live = runAccumulators.get(runId);
  if (live) return live;

  // Check persisted file
  try {
    const content = await fs.readFile(runCostPath(runId), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get today's running cost total.
 */
async function getTodayCost() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const log = await readDailyLog(dateStr);

  // Add any in-progress runs not yet finalized
  let liveCost = 0;
  let liveCalls = 0;
  let liveInput = 0;
  let liveOutput = 0;
  for (const acc of runAccumulators.values()) {
    liveCost += acc.totalCost;
    liveCalls += acc.calls;
    liveInput += acc.totalInputTokens;
    liveOutput += acc.totalOutputTokens;
  }

  return {
    date: dateStr,
    calls: log.totalCalls + liveCalls,
    inputTokens: log.totalInputTokens + liveInput,
    outputTokens: log.totalOutputTokens + liveOutput,
    cost: Math.round((log.totalCost + liveCost) * 1_000_000) / 1_000_000,
    runs: log.runs.length + runAccumulators.size,
    liveRuns: runAccumulators.size,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MODEL_PRICING,
  lookupModelPricing,
  estimateCost,
  extractUsageFromPayload,
  recordUsage,
  getRunUsage,
  clearRunAccumulator,
  restoreRunAccumulator,
  persistRunCost,
  finalizeRunCost,
  getCostSummary,
  getRunCostDetails,
  getTodayCost,
};
