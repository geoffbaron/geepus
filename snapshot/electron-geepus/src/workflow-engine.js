'use strict';

/**
 * workflow-engine.js — Multi-step pipeline engine with approval gates.
 *
 * A "pipeline" is an ordered list of steps (stages).  Each step has:
 *   - name, objective, executionMode, teamMode
 *   - requiresApproval  (boolean — pause before this step for human OK)
 *   - condition          (optional: "previous_success" | "always" | "previous_failure")
 *   - dependsOn          (optional step index — default: previous step)
 *
 * Pipelines are persisted as JSON in userData/pipelines.json.
 * Running a pipeline creates a "pipeline run" that tracks per-step state
 * and is persisted in userData/pipeline-runs/<id>.json.
 *
 * Depends on: settings.js, agent-loop.js, notifications.js, audit.js
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { app } = require('electron');

const { readSettings, normalizeRunLimits, DEFAULT_RUN_LIMITS } = require('./settings');
const { runObjectiveCore } = require('./agent-loop');
const { appendAuditEvent } = require('./audit');
const {
  notify,
  notifyTaskComplete,
  notifyTaskFailed,
  notifyTaskNeedsAttention,
} = require('./notifications');

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const PIPELINES_FILE = 'pipelines.json';
const PIPELINE_RUNS_DIR = 'pipeline-runs';

function pipelinesPath() {
  return path.join(app.getPath('userData'), PIPELINES_FILE);
}

function pipelineRunsDir() {
  return path.join(app.getPath('userData'), PIPELINE_RUNS_DIR);
}

function pipelineRunPath(runId) {
  return path.join(pipelineRunsDir(), `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Pipeline template CRUD
// ---------------------------------------------------------------------------

let pipelines = [];

function normalizePipelineStep(step, index) {
  return {
    index: typeof step.index === 'number' ? step.index : index,
    name: String(step.name || `Step ${index + 1}`).trim(),
    objective: String(step.objective || '').trim(),
    executionMode: step.executionMode === 'research' ? 'research' : (step.executionMode === 'auto' ? 'auto' : 'action'),
    teamMode: step.teamMode === 'solo' ? 'solo' : 'teams',
    workspaceRoot: String(step.workspaceRoot || '').trim(),
    requiresApproval: step.requiresApproval === true,
    condition: ['previous_success', 'always', 'previous_failure'].includes(step.condition)
      ? step.condition
      : 'previous_success',
  };
}

function normalizePipeline(pipeline) {
  const steps = Array.isArray(pipeline.steps)
    ? pipeline.steps.map((s, i) => normalizePipelineStep(s, i))
    : [];
  return {
    id: pipeline.id || crypto.randomUUID(),
    name: String(pipeline.name || 'Untitled Pipeline').trim(),
    description: String(pipeline.description || '').trim(),
    steps,
    enabled: pipeline.enabled !== false,
    createdAt: pipeline.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function loadPipelines() {
  try {
    const raw = await fs.readFile(pipelinesPath(), 'utf8');
    pipelines = JSON.parse(raw).map((p) => normalizePipeline(p));
  } catch {
    pipelines = [];
  }
  return pipelines;
}

async function savePipelines() {
  await fs.mkdir(path.dirname(pipelinesPath()), { recursive: true });
  await fs.writeFile(pipelinesPath(), JSON.stringify(pipelines, null, 2), 'utf8');
}

async function listPipelines() {
  if (pipelines.length === 0) await loadPipelines();
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    stepCount: p.steps.length,
    enabled: p.enabled,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

async function getPipeline(id) {
  if (pipelines.length === 0) await loadPipelines();
  return pipelines.find((p) => p.id === id) || null;
}

async function addPipeline(data) {
  if (pipelines.length === 0) await loadPipelines();
  const pipeline = normalizePipeline({ ...data, id: crypto.randomUUID() });
  pipelines.push(pipeline);
  await savePipelines();
  return pipeline;
}

async function updatePipeline(id, patch) {
  if (pipelines.length === 0) await loadPipelines();
  const idx = pipelines.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Pipeline not found: ${id}`);
  pipelines[idx] = normalizePipeline({ ...pipelines[idx], ...patch, id });
  await savePipelines();
  return pipelines[idx];
}

async function removePipeline(id) {
  if (pipelines.length === 0) await loadPipelines();
  const idx = pipelines.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  pipelines.splice(idx, 1);
  await savePipelines();
  return true;
}

// ---------------------------------------------------------------------------
// Pipeline Run state
// ---------------------------------------------------------------------------

/**
 * StepRun shape:
 *   { stepIndex, name, state, runId, result, startedAt, finishedAt, error }
 *
 * state: "pending" | "waiting_approval" | "running" | "completed" | "failed" | "skipped"
 */

function normalizeStepRun(step, stepDef) {
  return {
    stepIndex: step.stepIndex ?? stepDef.index,
    name: stepDef.name,
    objective: stepDef.objective,
    state: step.state || 'pending',
    runId: step.runId || null,
    result: step.result || null,
    startedAt: step.startedAt || null,
    finishedAt: step.finishedAt || null,
    error: step.error || null,
  };
}

function newPipelineRun(pipeline) {
  return {
    id: crypto.randomUUID(),
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    state: 'running',          // "running" | "paused" | "completed" | "failed" | "cancelled"
    currentStepIndex: 0,
    steps: pipeline.steps.map((stepDef, i) => normalizeStepRun({ stepIndex: i }, stepDef)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function persistPipelineRun(run) {
  const payload = { ...run, updatedAt: new Date().toISOString() };
  await fs.mkdir(pipelineRunsDir(), { recursive: true });
  await fs.writeFile(pipelineRunPath(payload.id), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function readPipelineRun(runId) {
  const raw = await fs.readFile(pipelineRunPath(runId), 'utf8');
  return JSON.parse(raw);
}

async function listPipelineRuns() {
  try {
    const dir = pipelineRunsDir();
    const files = await fs.readdir(dir);
    const runs = [];
    for (const file of files.filter((f) => f.endsWith('.json')).slice(-50)) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const run = JSON.parse(raw);
        runs.push({
          id: run.id,
          pipelineId: run.pipelineId,
          pipelineName: run.pipelineName,
          state: run.state,
          currentStepIndex: run.currentStepIndex,
          totalSteps: run.steps?.length || 0,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        });
      } catch { /* skip corrupt files */ }
    }
    return runs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step condition evaluation
// ---------------------------------------------------------------------------

function shouldRunStep(stepDef, previousStepRun) {
  if (!previousStepRun) return true; // first step always runs

  const condition = stepDef.condition || 'previous_success';
  if (condition === 'always') return true;
  if (condition === 'previous_success') return previousStepRun.state === 'completed';
  if (condition === 'previous_failure') return previousStepRun.state === 'failed';
  return previousStepRun.state === 'completed';
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

// Track currently active pipeline runs to prevent double-execution
const activePipelineRuns = new Set();

/**
 * Execute a pipeline from a given step index, pausing at approval gates.
 * Returns the updated pipeline run.
 */
async function executePipeline(pipelineId, options = {}) {
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

  let run;
  if (options.resumeRunId) {
    run = await readPipelineRun(options.resumeRunId);
    if (!run) throw new Error(`Pipeline run not found: ${options.resumeRunId}`);
  } else {
    run = newPipelineRun(pipeline);
  }

  if (activePipelineRuns.has(run.id)) {
    throw new Error('This pipeline is already running.');
  }
  activePipelineRuns.add(run.id);

  try {
    const settings = await readSettings();
    run.state = 'running';
    run = await persistPipelineRun(run);

    await appendAuditEvent({
      type: 'pipeline_started',
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      runId: run.id,
      totalSteps: pipeline.steps.length,
    });

    for (let i = run.currentStepIndex; i < pipeline.steps.length; i++) {
      const stepDef = pipeline.steps[i];
      const stepRun = run.steps[i];
      const previousStepRun = i > 0 ? run.steps[i - 1] : null;

      // --- Condition gate ---
      if (!shouldRunStep(stepDef, previousStepRun)) {
        stepRun.state = 'skipped';
        stepRun.finishedAt = new Date().toISOString();
        run.currentStepIndex = i + 1;
        run = await persistPipelineRun(run);
        continue;
      }

      // --- Approval gate ---
      if (stepDef.requiresApproval && stepRun.state !== 'running') {
        stepRun.state = 'waiting_approval';
        run.state = 'paused';
        run.currentStepIndex = i;
        run = await persistPipelineRun(run);

        notify({
          title: 'Pipeline awaiting approval',
          body: `Step ${i + 1}: "${stepDef.name}" needs your approval to proceed.`,
          level: 'warning',
          focusOnClick: true,
        });

        // Return — caller (or UI) must call approvePipelineStep to continue
        return run;
      }

      // --- Execute step ---
      stepRun.state = 'running';
      stepRun.startedAt = new Date().toISOString();
      run.currentStepIndex = i;
      run = await persistPipelineRun(run);

      try {
        const request = {
          task: stepDef.objective,
          executionMode: stepDef.executionMode,
          teamMode: stepDef.teamMode,
          workspaceRoot: stepDef.workspaceRoot || undefined,
        };

        const result = await runObjectiveCore(settings, request);

        stepRun.state = result.state === 'completed' ? 'completed' : 'failed';
        stepRun.runId = result.runId || null;
        stepRun.result = {
          state: result.state,
          reason: result.reason,
          report: typeof result.report === 'string' ? result.report.slice(0, 2000) : '',
          iterations: Array.isArray(result.iterations) ? result.iterations.length : 0,
        };
        stepRun.finishedAt = new Date().toISOString();

        if (stepRun.state === 'completed') {
          notifyTaskComplete({
            name: `Pipeline "${pipeline.name}" step ${i + 1}: ${stepDef.name}`,
          });
        } else {
          notifyTaskFailed({
            name: `Pipeline "${pipeline.name}" step ${i + 1}: ${stepDef.name}`,
          }, result.reason || 'Step failed');
        }
      } catch (error) {
        stepRun.state = 'failed';
        stepRun.error = error.message || String(error);
        stepRun.finishedAt = new Date().toISOString();

        notifyTaskFailed({
          name: `Pipeline "${pipeline.name}" step ${i + 1}: ${stepDef.name}`,
        }, stepRun.error);
      }

      run.currentStepIndex = i + 1;
      run = await persistPipelineRun(run);

      // If step failed and condition for next is "previous_success", pipeline stops
      if (stepRun.state === 'failed') {
        const nextStep = pipeline.steps[i + 1];
        if (nextStep && nextStep.condition !== 'always' && nextStep.condition !== 'previous_failure') {
          // Mark remaining steps as skipped
          for (let j = i + 1; j < pipeline.steps.length; j++) {
            run.steps[j].state = 'skipped';
            run.steps[j].finishedAt = new Date().toISOString();
          }
          run.state = 'failed';
          run = await persistPipelineRun(run);
          break;
        }
      }
    }

    // If we made it through all steps
    if (run.state === 'running') {
      const anyFailed = run.steps.some((s) => s.state === 'failed');
      run.state = anyFailed ? 'failed' : 'completed';
      run = await persistPipelineRun(run);
    }

    await appendAuditEvent({
      type: 'pipeline_finished',
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      runId: run.id,
      state: run.state,
      stepsCompleted: run.steps.filter((s) => s.state === 'completed').length,
      stepsFailed: run.steps.filter((s) => s.state === 'failed').length,
      stepsSkipped: run.steps.filter((s) => s.state === 'skipped').length,
    });

    if (run.state === 'completed') {
      notify({
        title: 'Pipeline completed',
        body: `"${pipeline.name}" finished successfully.`,
        level: 'success',
        focusOnClick: true,
      });
    } else if (run.state === 'failed') {
      notify({
        title: 'Pipeline failed',
        body: `"${pipeline.name}" had step failures.`,
        level: 'error',
        focusOnClick: true,
      });
    }

    return run;
  } finally {
    activePipelineRuns.delete(run.id);
  }
}

/**
 * Approve a paused step and resume execution.
 */
async function approvePipelineStep(pipelineRunId) {
  let run = await readPipelineRun(pipelineRunId);
  if (!run) throw new Error(`Pipeline run not found: ${pipelineRunId}`);
  if (run.state !== 'paused') throw new Error('Pipeline is not paused.');

  const stepIdx = run.currentStepIndex;
  if (stepIdx >= run.steps.length) throw new Error('No step to approve.');
  run.steps[stepIdx].state = 'running'; // clear waiting_approval
  run.state = 'running';
  run = await persistPipelineRun(run);

  // Resume execution from the current step
  return executePipeline(run.pipelineId, { resumeRunId: run.id });
}

/**
 * Reject (cancel) a paused pipeline step.
 */
async function rejectPipelineStep(pipelineRunId) {
  let run = await readPipelineRun(pipelineRunId);
  if (!run) throw new Error(`Pipeline run not found: ${pipelineRunId}`);
  if (run.state !== 'paused') throw new Error('Pipeline is not paused.');

  const stepIdx = run.currentStepIndex;
  run.steps[stepIdx].state = 'skipped';
  run.steps[stepIdx].finishedAt = new Date().toISOString();
  run.steps[stepIdx].error = 'Rejected by user.';

  // Skip remaining
  for (let j = stepIdx + 1; j < run.steps.length; j++) {
    run.steps[j].state = 'skipped';
    run.steps[j].finishedAt = new Date().toISOString();
  }

  run.state = 'cancelled';
  run = await persistPipelineRun(run);
  return run;
}

/**
 * Cancel a running or paused pipeline.
 */
async function cancelPipelineRun(pipelineRunId) {
  let run;
  try {
    run = await readPipelineRun(pipelineRunId);
  } catch {
    throw new Error(`Pipeline run not found: ${pipelineRunId}`);
  }

  for (let j = 0; j < run.steps.length; j++) {
    if (run.steps[j].state === 'pending' || run.steps[j].state === 'waiting_approval') {
      run.steps[j].state = 'skipped';
      run.steps[j].finishedAt = new Date().toISOString();
    }
  }

  run.state = 'cancelled';
  run = await persistPipelineRun(run);
  return run;
}

module.exports = {
  // Pipeline CRUD
  loadPipelines,
  listPipelines,
  getPipeline,
  addPipeline,
  updatePipeline,
  removePipeline,
  // Pipeline runs
  executePipeline,
  approvePipelineStep,
  rejectPipelineStep,
  cancelPipelineRun,
  readPipelineRun,
  listPipelineRuns,
  // For testing
  normalizePipeline,
  normalizePipelineStep,
  shouldRunStep,
};
