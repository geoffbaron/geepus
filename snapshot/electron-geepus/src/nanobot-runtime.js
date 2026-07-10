'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 11;

function parseJsonLine(raw) {
  try {
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}

function candidateNanobotRoots() {
  const explicit = String(process.env.GEEPUS_NANOBOT_PATH || '').trim();
  const roots = [
    explicit,
    path.resolve(__dirname, '..', '..', 'vendor', 'nanobot'),
    path.resolve(__dirname, '..', 'vendor', 'nanobot'),
    path.resolve(process.cwd(), 'vendor', 'nanobot'),
  ].filter(Boolean);
  return Array.from(new Set(roots));
}

function resolveNanobotRoot() {
  const fs = require('fs');
  for (const root of candidateNanobotRoots()) {
    const pkg = path.join(root, 'pyproject.toml');
    const mod = path.join(root, 'nanobot');
    if (fs.existsSync(pkg) && fs.existsSync(mod)) {
      return root;
    }
  }
  return '';
}

function candidatePythonCommands() {
  const explicit = String(process.env.GEEPUS_NANOBOT_PYTHON || '').trim();
  const list = [
    explicit,
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    'python3.12',
    'python3.11',
    'python3',
    'python',
  ].filter(Boolean);
  return Array.from(new Set(list));
}

function inspectPython(cmd) {
  const probe = spawnSync(
    cmd,
    ['-c', 'import sys, json; print(json.dumps({"major":sys.version_info[0],"minor":sys.version_info[1]}))'],
    {
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  if (probe.error || probe.status !== 0) {
    return null;
  }
  const parsed = parseJsonLine(probe.stdout);
  if (!parsed || !Number.isFinite(parsed.major) || !Number.isFinite(parsed.minor)) {
    return null;
  }
  return {
    cmd,
    major: Number(parsed.major),
    minor: Number(parsed.minor),
  };
}

function resolvePython() {
  for (const cmd of candidatePythonCommands()) {
    const info = inspectPython(cmd);
    if (!info) continue;
    if (info.major > MIN_PYTHON_MAJOR) return info;
    if (info.major === MIN_PYTHON_MAJOR && info.minor >= MIN_PYTHON_MINOR) return info;
  }
  return null;
}

function inspectNanobotDependencies(cmd, nanobotRoot) {
  const probeScript = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(String(nanobotRoot || ''))})`,
    'out = {"ok": True, "error": ""}',
    'try:',
    '    import nanobot.agent.loop',
    '    import nanobot.providers.litellm_provider',
    'except Exception as exc:',
    '    out["ok"] = False',
    '    out["error"] = f"{type(exc).__name__}: {exc}"',
    'print(json.dumps(out))',
  ].join('\n');
  const probe = spawnSync(
    cmd,
    ['-c', probeScript],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  if (probe.error || probe.status !== 0) {
    const stderr = String(probe.stderr || '').trim();
    return {
      ok: false,
      error: stderr || `Dependency probe failed (exit ${probe.status}).`,
    };
  }
  const parsed = parseJsonLine(probe.stdout);
  if (!parsed || parsed.ok !== true) {
    return {
      ok: false,
      error: String(parsed?.error || 'Dependency probe failed to parse output.'),
    };
  }
  return { ok: true, error: '' };
}

function getRuntimeAvailability() {
  if (String(process.env.GEEPUS_DISABLE_NANOBOT_NATIVE || '').trim() === '1') {
    return {
      available: false,
      reason: 'Native Nanobot runtime is disabled via GEEPUS_DISABLE_NANOBOT_NATIVE=1.',
    };
  }

  const nanobotRoot = resolveNanobotRoot();
  if (!nanobotRoot) {
    return {
      available: false,
      reason: 'Nanobot vendor bundle was not found. Expected vendor/nanobot with pyproject.toml.',
    };
  }

  const python = resolvePython();
  if (!python) {
    return {
      available: false,
      reason: 'Python 3.11+ was not found. Set GEEPUS_NANOBOT_PYTHON to a Python 3.11+ binary.',
    };
  }

  const deps = inspectNanobotDependencies(python.cmd, nanobotRoot);
  if (!deps.ok) {
    return {
      available: false,
      reason: [
        'Nanobot Python dependencies are missing for the selected interpreter.',
        deps.error ? `Import error: ${deps.error}` : '',
        'Install requirements in Python 3.11+ (internet access required), then retry.',
      ].filter(Boolean).join(' '),
    };
  }

  const bridgeScript = path.resolve(__dirname, 'nanobot-runtime-bridge.py');
  return {
    available: true,
    nanobotRoot,
    python,
    bridgeScript,
  };
}

async function runNanobotNativeObjective({
  objective = '',
  threadContext = '',
  workspaceRoot = '',
  provider = 'openai',
  apiKey = '',
  baseUrl = '',
  model = '',
  braveSearchApiKey = '',
  maxToolIterations = 40,
  runId = '',
  onProgress = null,
  onCheckpoint = null,
  onChildProcess = null,
  onChildProcessDone = null,
}) {
  const runtime = getRuntimeAvailability();
  if (!runtime.available) {
    return {
      used: false,
      reason: runtime.reason,
      diagnostics: runtime,
    };
  }

  const content = threadContext
    ? `${objective}\n\nConversation context:\n${threadContext}`
    : objective;
  const payload = {
    nanobotRoot: runtime.nanobotRoot,
    workspaceRoot,
    content,
    provider,
    apiKey: String(apiKey || ''),
    baseUrl: String(baseUrl || ''),
    model: String(model || ''),
    braveSearchApiKey: String(braveSearchApiKey || ''),
    maxToolIterations: Number(maxToolIterations || 40),
    sessionKey: `geepus:${runId || 'direct'}`,
    channel: 'cli',
    chatId: runId || 'direct',
  };

  const child = spawn(runtime.python.cmd, [runtime.bridgeScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (typeof onChildProcess === 'function') {
    try {
      onChildProcess(child);
    } catch {
      // no-op
    }
  }

  let resultMessage = null;
  let errorMessage = '';
  let stderrText = '';
  const unparsedStdout = [];
  const liveEvents = [];
  let checkpointStop = null;

  async function maybeHandleCheckpoint(event) {
    if (typeof onCheckpoint !== 'function' || checkpointStop?.requested) {
      return;
    }
    let directive = null;
    try {
      directive = await onCheckpoint(event);
    } catch {
      directive = null;
    }
    if (!directive || directive.stop !== true || checkpointStop?.requested) {
      return;
    }
    checkpointStop = {
      requested: true,
      reason: String(directive.reason || 'Stopped at Geepus native checkpoint.').trim(),
      summary: String(directive.summary || '').trim(),
      report: String(directive.report || '').trim(),
      disposition: String(directive.disposition || 'complete').trim().toLowerCase(),
      repairBrief: String(directive.repairBrief || '').trim(),
      at: new Date().toISOString(),
    };
    try {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    } catch {
      // no-op
    }
  }

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on('line', (line) => {
    const parsed = parseJsonLine(line);
    if (!parsed) {
      unparsedStdout.push(line);
      return;
    }
    const type = String(parsed.type || '').toLowerCase();
    if (type === 'progress') {
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            type,
            content: String(parsed.content || ''),
            toolHint: parsed.toolHint === true,
          });
        } catch {
          // no-op
        }
      }
      return;
    }
    if (type === 'tool_call' || type === 'tool_result' || type === 'milestone' || type === 'verification_signal') {
      liveEvents.push(parsed);
      maybeHandleCheckpoint(parsed).catch(() => {});
      if (typeof onProgress === 'function') {
        try {
          onProgress(parsed);
        } catch {
          // no-op
        }
      }
      return;
    }
    if (type === 'error') {
      errorMessage = String(parsed.error || parsed.message || 'Nanobot runtime error.');
      return;
    }
    if (type === 'result') {
      resultMessage = {
        content: String(parsed.content || ''),
        toolsUsed: Array.isArray(parsed.toolsUsed) ? parsed.toolsUsed.map((item) => String(item || '').trim()).filter(Boolean) : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        milestones: Array.isArray(parsed.milestones) ? parsed.milestones.map((item) => String(item || '').trim()).filter(Boolean) : [],
      };
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk || '');
  });

  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch (error) {
    errorMessage = `Failed to send payload to Nanobot runtime: ${error.message || error}`;
    try {
      child.kill('SIGTERM');
    } catch {
      // no-op
    }
  }

  const exitInfo = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    if (typeof onChildProcessDone === 'function') {
      try {
        onChildProcessDone(child);
      } catch {
        // no-op
      }
    }
  });

  if (resultMessage && exitInfo.code === 0) {
    return {
      used: true,
      response: resultMessage.content,
      toolsUsed: resultMessage.toolsUsed || [],
      messages: resultMessage.messages || [],
      milestones: resultMessage.milestones || [],
      liveEvents,
      reason: 'Completed via Nanobot native runtime.',
      diagnostics: runtime,
    };
  }

  if (checkpointStop?.requested && (exitInfo.signal || exitInfo.code === 0)) {
    return {
      used: true,
      checkpointStopped: true,
      response: resultMessage?.content || checkpointStop.report || '',
      toolsUsed: resultMessage?.toolsUsed || [],
      messages: resultMessage?.messages || [],
      milestones: resultMessage?.milestones || [],
      liveEvents,
      reason: checkpointStop.reason,
      checkpointSummary: checkpointStop.summary,
      checkpointDisposition: checkpointStop.disposition || 'complete',
      repairBrief: checkpointStop.repairBrief || '',
      diagnostics: runtime,
    };
  }

  const lines = [];
  if (errorMessage) lines.push(errorMessage);
  if (stderrText.trim()) lines.push(stderrText.trim());
  if (unparsedStdout.length > 0) lines.push(unparsedStdout.join('\n').trim());
  if (exitInfo.signal) lines.push(`Nanobot runtime terminated by signal ${exitInfo.signal}.`);
  if (!exitInfo.signal && exitInfo.code !== 0) lines.push(`Nanobot runtime exited with code ${exitInfo.code}.`);

  return {
    used: false,
    reason: lines.filter(Boolean).join('\n') || 'Nanobot runtime failed before producing a response.',
    diagnostics: runtime,
  };
}

module.exports = {
  getRuntimeAvailability,
  runNanobotNativeObjective,
};
