'use strict';

const path = require('path');
const fs = require('fs/promises');
const { spawn, execSync } = require('child_process');
const { app, nativeImage } = require('electron');

const { ensureObject, clampNumber, truncate, normalizeRisk } = require('./utils');
const { normalizeOwner, inferOwnerFromAction } = require('./team');
const { resolveWorkspacePath, listWorkspaceFiles } = require('./workspace');
const { launchBrowserAction, performBrowserAction, closeBrowserAction } = require('./browser-session');

// ---------------------------------------------------------------------------
// Resolve the user's full shell PATH so spawned commands can find node, npm,
// brew, etc. macOS GUI apps don't inherit the interactive shell PATH.
// ---------------------------------------------------------------------------
let _resolvedPath = '';
function getShellPath() {
  if (_resolvedPath) return _resolvedPath;
  const extraDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
  ];
  try {
    // Ask the user's default shell for the real PATH
    const shell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`${shell} -ilc 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env },
    }).trim();
    if (shellPath) {
      // Merge: shell PATH first, then extras, then current process PATH
      const combined = [...new Set([
        ...shellPath.split(':'),
        ...extraDirs,
        ...(process.env.PATH || '').split(':'),
      ])].filter(Boolean);
      _resolvedPath = combined.join(':');
      return _resolvedPath;
    }
  } catch {
    // Shell probe failed — fall back to hardcoded extras
  }
  const combined = [...new Set([
    ...extraDirs,
    ...(process.env.PATH || '').split(':'),
  ])].filter(Boolean);
  _resolvedPath = combined.join(':');
  return _resolvedPath;
}
const {
  StopRequestedError,
  isRunStopRequested,
  getRunStopReason,
  registerRunChild,
  unregisterRunChild,
  throwIfRunStopped,
} = require('./run-state');
const { broadcastWatchEvent } = require('./watch-manager');
const { executeWebSearch, executeWebScrape, executeWebFetch } = require('./web-research');
const { executeIntegrationAction, isPushApproved } = require('./integrations');
const {
  normalizeProvider,
  normalizeBaseUrl,
  apiHeaders,
  extractOutputText,
  parseError,
  resolveAgentModel,
} = require('./providers');

function sanitizePathArg(rawPath) {
  let value = String(rawPath || '').trim();
  if (!value) return '';
  value = value.replace(/^['"`]+|['"`]+$/g, '').trim();
  if (!value) return '';

  // Handle assistant-style phrasing like:
  // "Verify output file exists: open output-file.pdf"
  const colonSplit = value.split(':');
  if (colonSplit.length > 1) {
    const tail = colonSplit[colonSplit.length - 1].trim();
    if (tail) {
      value = tail;
    }
  }

  value = value.replace(/\s+/g, ' ').trim();

  const commandPrefixes = [
    'open ',
    'read ',
    'view ',
    'cat ',
    'inspect ',
    'analyze ',
    'verify ',
    'check ',
  ];
  for (const prefix of commandPrefixes) {
    if (value.toLowerCase().startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }

  return value;
}

async function resolveExistingWorkspacePath(workspaceRoot, rawPath) {
  const requested = sanitizePathArg(rawPath);
  if (!requested) {
    throw new Error('Missing file path.');
  }
  const direct = resolveWorkspacePath(workspaceRoot, requested);
  try {
    await fs.access(direct);
    return { target: direct, requestedPath: requested, fallbackUsed: false };
  } catch {
    // Continue with basename fallback.
  }

  const base = path.basename(requested).trim();
  if (!base || base === '.' || base === '..') {
    throw new Error(`File not found: ${requested}`);
  }

  const entries = await listWorkspaceFiles(workspaceRoot, 6, 2000);
  const match = entries
    .map((entry) => String(entry || '').replace(/\/+$/, ''))
    .find((entry) => path.basename(entry) === base);

  if (!match) {
    throw new Error(`File not found: ${requested}. Use list_files or search_files to locate it first.`);
  }

  const resolved = resolveWorkspacePath(workspaceRoot, match);
  return {
    target: resolved,
    requestedPath: requested,
    fallbackUsed: true,
    matchedRelativePath: match,
  };
}

function normalizeAction(rawAction) {
  const action = ensureObject(rawAction);
  // Robust: accept alternate field names that local models may produce
  let tool = String(action.tool || action.name || action.type || action.function || action.action || action.command || '').trim().toLowerCase();
  // Always create a NEW shallow copy — never mutate the original action's exact_args
  // because the LLM response object may have shared references that become circular
  // if we later add new keys into the same object.
  let exactArgs = Object.assign({}, ensureObject(action.exact_args || action.args || action.arguments || action.parameters || action.params));

  // If no exact_args were found, check whether the model put args at the top level of the
  // action object (a common pattern for local models).  Exclude reserved action-level keys.
  if (Object.keys(exactArgs).length === 0) {
    const RESERVED = new Set([
      'tool', 'name', 'type', 'function', 'command',
      'intent', 'description', 'owner', 'expected_diff', 'rollback_plan', 'risk_level',
      'policy_allowed', 'policy_reason', 'effective_risk',
    ]);

    // Note: 'action' was removed from RESERVED. It is used as a generic tool alias
    // (action.action) but it is critically the primary argument for `browser_action`.
    // We will conditionally skip it if it's not a browser_action.

    for (const k of Object.keys(action)) {
      if (k === 'action' && tool !== 'browser_action' && tool !== 'browseraction') {
        continue;
      }
      if (!RESERVED.has(k)) {
        exactArgs[k] = action[k];
      }
    }
  }

  // Normalize camelCase / PascalCase tool names (e.g. "writeFile" → "write_file")
  const camelMap = {
    listfiles: 'list_files', readfile: 'read_file', writefile: 'write_file',
    appendfile: 'append_file', runcommand: 'run_command', runplaywright: 'run_playwright',
    websearch: 'web_search', webscrape: 'web_scrape',
    patchfile: 'patch_file', searchfiles: 'search_files',
    httprequest: 'http_request', analyzeimage: 'analyze_image',
    browserlaunch: 'browser_launch', browseraction: 'browser_action', browserclose: 'browser_close',
  };
  const noUnderscores = tool.replace(/_/g, '');
  if (camelMap[noUnderscores]) {
    tool = camelMap[noUnderscores];
  }

  // Common alternate tool names local models may produce
  const toolAliases = {
    create_file: 'write_file', edit_file: 'write_file', save_file: 'write_file',
    delete_file: 'write_file', modify_file: 'write_file', update_file: 'write_file',
    execute: 'run_command', exec: 'run_command', shell: 'run_command',
    terminal: 'run_command', command: 'run_command', run: 'run_command',
    search: 'web_search', browse: 'web_scrape', fetch: 'web_scrape',
    playwright: 'run_playwright', browser: 'run_playwright',
    browser_launch: 'browser_launch', browser_open: 'browser_launch',
    browser_action: 'browser_action', browser_click: 'browser_action', browser_type: 'browser_action', browser_interact: 'browser_action',
    browser_close: 'browser_close', browser_quit: 'browser_close',
    vision: 'analyze_image', inspect_image: 'analyze_image', view_image: 'analyze_image',
    ls: 'list_files', dir: 'list_files', find: 'list_files',
    cat: 'read_file', read: 'read_file', view: 'read_file',
    write: 'write_file', append: 'append_file',
    edit: 'patch_file', patch: 'patch_file', replace: 'patch_file',
    sed: 'patch_file', modify: 'patch_file',
    grep: 'search_files', ripgrep: 'search_files', rg: 'search_files',
    find_in_files: 'search_files', code_search: 'search_files',
    reason: 'think', plan: 'think', analyze: 'think', reflect: 'think', debug: 'think',
    http: 'http_request', request: 'http_request', api_call: 'http_request', test_endpoint: 'http_request',
    consult: 'delegate', ask_specialist: 'delegate', subagent: 'delegate', specialist: 'delegate',
  };
  if (toolAliases[tool]) {
    tool = toolAliases[tool];
  }

  if (tool === 'browser_action') {
    const nestedAction = String(exactArgs.action || '').trim().toLowerCase();
    if (nestedAction === 'navigate') {
      exactArgs.action = 'goto';
    }
    if (!nestedAction || nestedAction === 'browser_action' || nestedAction === 'browseraction') {
      const intentText = `${String(action.intent || '')} ${String(action.description || '')}`.toLowerCase();
      if (/\b(type|fill|enter)\b/.test(intentText)) exactArgs.action = 'type';
      else if (/\b(read|inspect|snapshot|observe)\b/.test(intentText)) exactArgs.action = 'aria_snapshot';
      else if (/\b(wait)\b/.test(intentText)) exactArgs.action = 'wait_for';
      else exactArgs.action = 'click';
    }
  }

  // ── Sentence-in-tool detection ────────────────────────────────────────────
  // Some models (qwen, mistral, etc.) put the full task description in the
  // `tool` field instead of a valid tool name, e.g.:
  //   "tool": "go to google.com and search for X"
  // Detect this pattern and infer the real tool from keywords in the sentence.
  if (tool.includes(' ') || tool.length > 30) {
    const sentenceHint = tool; // the full hallucinated sentence
    const s = sentenceHint.toLowerCase();

    let inferred = '';
    if (/\b(search|look up|google|find information)\b/.test(s)) {
      inferred = 'web_search';
      // Try to extract query from the sentence
      if (!exactArgs.query) {
        const qMatch = s.match(/(?:search|search for|look up|google)\s+(.{3,80})/);
        if (qMatch) exactArgs.query = qMatch[1].replace(/['"]/g, '').trim();
      }
    } else if (/\b(navigate|go to|open|visit|browse|launch|load)\b.*\b(http|www|\.com|\.org|\.io|url|site|page|website)\b/.test(s)) {
      inferred = 'browser_launch';
      if (!exactArgs.url) {
        const urlMatch = sentenceHint.match(/https?:\/\/[^\s"')]+/);
        if (urlMatch) exactArgs.url = urlMatch[0];
      }
    } else if (/\b(click|press|type|fill|enter|submit|select)\b/.test(s)) {
      inferred = 'browser_action';
      if (!exactArgs.action) exactArgs.action = 'click';
    } else if (/\b(scrape|extract|read.*page|get.*content)\b/.test(s)) {
      inferred = 'web_scrape';
    } else if (/\b(write|create|save|generate).*\b(file|code|script)\b/.test(s)) {
      inferred = 'write_file';
    } else if (/\b(run|execute|install|npm|node|python)\b/.test(s)) {
      inferred = 'run_command';
    } else if (/\b(think|reason|plan|consider|analyze|decide)\b/.test(s)) {
      inferred = 'think';
      if (!exactArgs.thought) exactArgs.thought = sentenceHint;
    } else {
      // Last resort: treat it as a think action so it doesn't become safeguard_rejected
      inferred = 'think';
      if (!exactArgs.thought) exactArgs.thought = sentenceHint;
    }

    console.log(`[normalizeAction] Sentence-as-tool detected: "${sentenceHint.slice(0, 60)}..." → inferred tool: "${inferred}"`);
    tool = inferred;
  }


  // Directory-creation pseudo-tools — local models commonly hallucinate these.
  // Map them to run_command mkdir -p <path>.
  const dirCreateNames = new Set([
    'createdirectory', 'makedirectory', 'createdir', 'makedir',
    'create_directory', 'make_directory', 'mkdir_p',
    'createfolder', 'makefolder', 'create_folder', 'make_folder',
  ]);
  if (dirCreateNames.has(tool) || dirCreateNames.has(noUnderscores)) {
    console.log('[normalizeAction] Converting directory pseudo-tool:', tool, '→ run_command mkdir -p');
    const dirPath = exactArgs.path || exactArgs.directory || exactArgs.dir
      || exactArgs.folder || exactArgs.name || exactArgs.target || '';
    exactArgs = {
      command: 'mkdir',
      args: ['-p', dirPath].filter(Boolean),
      cwd: exactArgs.cwd || '',
      timeout_ms: 10000,
    };
    tool = 'run_command';
  }

  // Normalize command-like tool names into run_command
  // Models sometimes emit "open", "git", "npm", etc. as top-level tools
  const commandAliases = new Set([
    'open', 'git', 'npm', 'npx', 'node', 'python', 'python3',
    'pip', 'pip3', 'brew', 'swift', 'cargo', 'go', 'make',
    'docker', 'kubectl', 'curl', 'wget', 'zip', 'unzip', 'tar',
    'sh', 'bash', 'zsh', 'ruby', 'perl',
    // Dev tools — models sometimes emit these as tool names
    'vscode', 'code', 'xcode', 'xcodebuild', 'xcrun', 'xcode-select',
    'swiftc', 'clang', 'gcc', 'g++', 'cmake', 'gradle', 'mvn', 'maven',
    'dotnet', 'rustc', 'javac', 'java', 'deno', 'bun',
    'pod', 'cocoapods', 'fastlane', 'flutter', 'expo',
    'pytest', 'jest', 'vitest', 'mocha', 'playwright',
    'eslint', 'prettier', 'tsc', 'webpack', 'vite', 'rollup', 'esbuild',
    'cp', 'mv', 'rm', 'mkdir', 'chmod', 'ln', 'cat', 'echo',
    'sed', 'awk', 'sort', 'head', 'tail', 'wc', 'diff', 'find', 'xargs',
  ]);

  // NEVER normalize our explicit safeguard pseudo-tool so the agent receives the explicit error
  if (tool !== 'safeguard_rejected' && commandAliases.has(tool)) {
    const aliasedCommand = tool;
    const aliasedArgs = Array.isArray(exactArgs.args) ? exactArgs.args : [];
    // If the model put the target in a 'url', 'path', or 'target' field, use that
    const target = exactArgs.url || exactArgs.path || exactArgs.target || '';
    const mergedArgs = target ? [target, ...aliasedArgs] : aliasedArgs;
    exactArgs = {
      command: aliasedCommand,
      args: mergedArgs,
      cwd: exactArgs.cwd || '',
      timeout_ms: exactArgs.timeout_ms || 180000,
    };
    tool = 'run_command';
  }

  // Fix run_command with empty/missing command — common local model failure.
  // Try to recover the command from nested structure or args.
  if (tool === 'run_command') {
    const cmd = String(exactArgs.command || '').trim();
    if (!cmd) {
      // Model may have put the full command string as the first arg
      const firstArg = Array.isArray(exactArgs.args) ? String(exactArgs.args[0] || '').trim() : '';
      // Or it may have put it in 'cmd', 'program', 'executable', 'bin', or 'script' fields
      const altCmd = exactArgs.cmd || exactArgs.program || exactArgs.executable
        || exactArgs.bin || exactArgs.script || '';
      if (altCmd) {
        exactArgs.command = String(altCmd).trim();
      } else if (firstArg && /^[a-zA-Z0-9._/-]+$/.test(firstArg)) {
        // First arg looks like a command name — promote it
        exactArgs.command = firstArg;
        if (Array.isArray(exactArgs.args)) exactArgs.args = exactArgs.args.slice(1);
      } else {
        // Last resort: if the model put everything in a single 'command' string like "mkdir -p /path",
        // or the action has a text field with the full shell command
        const shellCmd = exactArgs.shell || exactArgs.run || exactArgs.exec || '';
        if (shellCmd) {
          exactArgs.command = 'bash';
          exactArgs.args = ['-c', String(shellCmd)];
        }
      }
    }
  }

  const owner = normalizeOwner(action.owner) || inferOwnerFromAction(action);

  // Normalize exact_args field names for file tools
  // The executor expects "path" and "content", but models may produce "file_path", "file", "filename", etc.
  if (tool === 'read_file' || tool === 'write_file' || tool === 'append_file' || tool === 'list_files' || tool === 'patch_file' || tool === 'analyze_image') {
    if (!exactArgs.path) {
      exactArgs.path = exactArgs.file_path || exactArgs.file || exactArgs.filename
        || exactArgs.filepath || exactArgs.target || exactArgs.fileName
        || exactArgs.file_name || exactArgs.destination || exactArgs.output_file
        || exactArgs.output || exactArgs.src || exactArgs.source || '';
    }
    exactArgs.path = sanitizePathArg(exactArgs.path);
    if ((tool === 'write_file' || tool === 'append_file') && !exactArgs.content) {
      const _altContent = exactArgs.contents || exactArgs.text || exactArgs.data
        || exactArgs.body || exactArgs.source_code || exactArgs.code
        || exactArgs.content_text;
      if (_altContent !== undefined) exactArgs.content = _altContent;
    }
  }

  // Normalize patch_file args: accept various names for search/replace strings
  if (tool === 'patch_file') {
    if (!exactArgs.search && (exactArgs.old || exactArgs.old_string || exactArgs.find || exactArgs.match || exactArgs.pattern || exactArgs.from)) {
      exactArgs.search = exactArgs.old || exactArgs.old_string || exactArgs.find || exactArgs.match || exactArgs.pattern || exactArgs.from;
    }
    if (!exactArgs.replace && exactArgs.replace === undefined && (exactArgs.new_string || exactArgs.replacement || exactArgs.to || exactArgs.with)) {
      exactArgs.replace = exactArgs.new_string || exactArgs.replacement || exactArgs.to || exactArgs.with;
    }
    // Also accept "new" but carefully since it's a JS keyword
    if (!exactArgs.replace && exactArgs.replace === undefined && typeof exactArgs['new'] === 'string') {
      exactArgs.replace = exactArgs['new'];
    }
  }

  // Normalize search_files args
  if (tool === 'search_files') {
    if (!exactArgs.pattern && (exactArgs.query || exactArgs.search || exactArgs.text || exactArgs.term || exactArgs.regex)) {
      exactArgs.pattern = exactArgs.query || exactArgs.search || exactArgs.text || exactArgs.term || exactArgs.regex;
    }
  }

  // Normalize think args
  if (tool === 'think') {
    if (!exactArgs.thought && (exactArgs.reasoning || exactArgs.analysis || exactArgs.content || exactArgs.text || exactArgs.message)) {
      exactArgs.thought = exactArgs.reasoning || exactArgs.analysis || exactArgs.content || exactArgs.text || exactArgs.message;
    }
  }

  // Normalize delegate args
  if (tool === 'delegate') {
    if (!exactArgs.role && (exactArgs.specialist || exactArgs.agent || exactArgs.to)) {
      exactArgs.role = exactArgs.specialist || exactArgs.agent || exactArgs.to;
    }
    if (!exactArgs.task && (exactArgs.question || exactArgs.prompt || exactArgs.request || exactArgs.objective)) {
      exactArgs.task = exactArgs.question || exactArgs.prompt || exactArgs.request || exactArgs.objective;
    }
  }

  // Fix paths where the model used "/Users/geepus" as a home directory by confusing
  // the app name with a Unix username. Replace with the real user's home directory.
  const _realHome = process.env.HOME || '';
  if (_realHome) {
    const _fixPath = (v) => (typeof v === 'string' ? v.replace(/\/Users\/geepus\b/g, _realHome) : v);
    // Apply to all string values one level deep in exactArgs
    for (const k of Object.keys(exactArgs)) {
      if (typeof exactArgs[k] === 'string') {
        exactArgs[k] = _fixPath(exactArgs[k]);
      } else if (Array.isArray(exactArgs[k])) {
        exactArgs[k] = exactArgs[k].map(_fixPath);
      }
    }
  }

  return {
    intent: String(action.intent || action.description || '').trim() || 'Execute requested task',
    owner,
    tool,
    exact_args: exactArgs,
    expected_diff: String(action.expected_diff || '').trim(),
    rollback_plan: String(action.rollback_plan || '').trim() || 'Restore previous state from backup/snapshot.',
    risk_level: normalizeRisk(action.risk_level),
  };
}

function normalizePlan(rawPlan) {
  const plan = ensureObject(rawPlan);
  // Robust: accept alternate array field names that local models may produce
  let rawActions = plan.actions || plan.steps || plan.tasks || plan.plan || [];

  // If the plan IS an array (model returned array instead of object), use it directly
  if (Array.isArray(rawPlan)) {
    rawActions = rawPlan;
  }

  // If rawActions is a single object (model returned one action without wrapping in array), wrap it
  if (rawActions && typeof rawActions === 'object' && !Array.isArray(rawActions)) {
    // Check if it looks like an action (has tool/name/command)
    if (rawActions.tool || rawActions.name || rawActions.command || rawActions.function) {
      rawActions = [rawActions];
    }
  }

  // ── Detect LLM API error payloads disguised as plan objects ──────────────
  // When the LLM API returns an error (context overflow, auth failure, etc.),
  // it sometimes comes back as JSON with an `error` key or an action with
  // `tool: ''` and `exact_args: { error: {...} }`. Detect and throw early
  // so the planner can handle retries/truncation rather than looping forever.
  if (plan.error && typeof plan.error === 'object') {
    const msg = String(plan.error.message || plan.error.type || 'LLM API error');
    throw new Error('LLM API error: ' + msg);
  }

  const actions = Array.isArray(rawActions) ? rawActions.map(normalizeAction) : [];

  // Filter out actions with empty tool names — these are artifacts of LLM API errors
  // being embedded in the JSON response. Pass them through would cause safeguard loops.
  const validActions = actions.filter(a => {
    if (!a.tool) {
      // Check if this is actually an API error disguised as an action
      const errObj = a.exact_args && a.exact_args.error;
      if (errObj && typeof errObj === 'object') {
        const errMsg = String(errObj.message || errObj.type || '');
        // Context overflow is a fatal error — the planner needs to know
        if (errMsg.includes('context') || errMsg.includes('token') || errMsg.includes('length')) {
          throw new Error('Context limit exceeded: ' + errMsg.slice(0, 200));
        }
        throw new Error('LLM API error in action: ' + errMsg.slice(0, 200));
      }
      return false; // silently drop other empty-tool actions
    }
    return true;
  });

  // If the model says "done" with no actions, that's a valid completion signal
  if (validActions.length === 0 && plan.done !== true) {
    // Log diagnostic info for debugging
    const keys = Object.keys(plan);
    console.log('[normalizePlan] No actions found. Plan keys:', keys.join(', '),
      '| Plan preview:', JSON.stringify(plan).slice(0, 500));
    throw new Error('Model did not return any executable actions.');
  }

  return {
    summary: String(plan.summary || plan.intent || 'Agent execution plan').trim(),
    actions: validActions,
    done: plan.done === true,
  };
}

const IMAGE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
]);

function inferImageMime(filePath, buffer) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (IMAGE_MIME_BY_EXT.has(ext)) return IMAGE_MIME_BY_EXT.get(ext);
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return '';
}

function looksBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sampleLength = Math.min(buffer.length, 4000);
  let zeroBytes = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) {
      zeroBytes += 1;
      if (zeroBytes > 2) return true;
    }
  }
  return false;
}

function makeLargeTextPreview(text) {
  const head = text.slice(0, 120000);
  const tail = text.slice(-60000);
  return `${head}\n\n...[truncated ${Math.max(0, text.length - (head.length + tail.length))} chars]...\n\n${tail}`;
}

function readImageDimensions(targetPath, buffer) {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    const { width, height } = image.getSize();
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // Ignore and fall back to path loading.
  }
  try {
    const image = nativeImage.createFromPath(targetPath);
    const { width, height } = image.getSize();
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // Ignore.
  }
  return { width: 0, height: 0 };
}

async function pathExistsAsFile(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExistsAsDirectory(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findFallbackCwdForCommand(command, commandArgs, workspaceRoot, currentCwd) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!(cmd === 'node' || cmd === 'npm' || cmd === 'npx')) {
    return '';
  }
  if (path.resolve(currentCwd || '') !== path.resolve(workspaceRoot || '')) {
    return '';
  }

  // Node script execution: use the script folder as cwd if possible.
  if (cmd === 'node') {
    const scriptExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
    for (const rawArg of (Array.isArray(commandArgs) ? commandArgs : [])) {
      const token = String(rawArg || '').trim();
      if (!token || token.startsWith('-')) continue;
      const ext = path.extname(token).toLowerCase();
      if (!scriptExts.has(ext)) continue;
      try {
        const abs = resolveWorkspacePath(workspaceRoot, token);
        if (await pathExistsAsFile(abs)) {
          const dir = path.dirname(abs);
          if (dir && (await pathExistsAsDirectory(dir))) {
            return dir;
          }
        }
      } catch {
        // Ignore invalid path resolution.
      }
    }
  }

  // npm/npx: honor explicit directory flags.
  const flagPairs = new Set(['--prefix', '-c', '-C', '--workspace', '-w']);
  const args = Array.isArray(commandArgs) ? commandArgs : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '').trim();
    if (!flagPairs.has(token)) continue;
    const value = String(args[i + 1] || '').trim();
    if (!value) continue;
    try {
      const abs = resolveWorkspacePath(workspaceRoot, value);
      if (await pathExistsAsDirectory(abs)) {
        return abs;
      }
      if (await pathExistsAsFile(abs)) {
        return path.dirname(abs);
      }
    } catch {
      // Ignore invalid path resolution.
    }
    i += 1;
  }

  // Generic fallback: if any argument points to a file/dir, use its directory.
  for (const rawArg of args) {
    const token = String(rawArg || '').trim();
    if (!token || token.startsWith('-') || !token.includes('/')) continue;
    try {
      const abs = resolveWorkspacePath(workspaceRoot, token);
      if (await pathExistsAsDirectory(abs)) {
        return abs;
      }
      if (await pathExistsAsFile(abs)) {
        return path.dirname(abs);
      }
    } catch {
      // Ignore invalid path resolution.
    }
  }

  return '';
}

function isSecurityGrantActive(timestamp) {
  return Number(timestamp || 0) > Date.now();
}

async function runVisionAnalysis({
  settings,
  model,
  prompt,
  mimeType,
  imageBase64,
}) {
  const provider = normalizeProvider(settings.provider);
  const endpointBase = normalizeBaseUrl(settings.baseUrl, provider);
  let endpoint = '';
  let body = {};

  // Dynamically resolve a model capable of vision (this falls back optimally instead of hard-coding)
  let resolvedModelInfo;
  try {
    resolvedModelInfo = await resolveAgentModel(settings, model, '', ['isVision']);
    model = resolvedModelInfo.model;
  } catch (err) {
    // If no vision model is found, we fall back to the existing or fallback logic
    console.warn("Failed to dynamically resolve vision model, falling back to original model:", err);
  }

  if (provider === 'anthropic') {
    endpoint = `${endpointBase}/messages`;
    body = {
      model,
      max_tokens: 1200,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
    };
  } else if (provider === 'ollama') {
    endpoint = `${endpointBase}/chat/completions`;
    body = {
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ],
        },
      ],
    };
  } else {
    endpoint = `${endpointBase}/responses`;
    body = {
      model,
      temperature: 0.1,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}` },
          ],
        },
      ],
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: apiHeaders(provider, settings.apiKey || ''),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  const payload = await response.json();
  return extractOutputText(provider, payload);
}

function commandPolicy(command, args) {
  // Hard-blocked: system-level commands that should never be run by an agent
  const blockedCommands = new Set([
    'sudo',
    'su',
    'launchctl',
    'osascript',
    'security',
    'dd',
    'diskutil',
    'chown',
  ]);

  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    // Empty or invalid command — don't hard-deny, convert to echo so the run keeps going
    // and the model gets a clear error message to learn from.
    return { allowed: true, risk: 'low', reason: `Empty/invalid command token — will produce an error the model can learn from.` };
  }
  if (blockedCommands.has(command)) {
    return { allowed: false, risk: 'high', reason: `Command blocked by policy: ${command}` };
  }

  // --- Git ---
  if (command === 'git') {
    const sub = String(args[0] || '');
    if (sub === 'push') {
      return { allowed: 'gated', risk: 'high', reason: 'git push requires explicit per-run approval.' };
    }
    const lowRisk = new Set(['status', 'diff', 'log', 'branch', 'show', 'tag', 'remote',
      'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'blame', 'reflog',
      'config', 'fetch', 'stash']);
    const mediumRisk = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge',
      'rebase', 'pull', 'clone', 'init', 'reset', 'clean', 'rm', 'mv', 'cherry-pick',
      'submodule', 'apply', 'am']);
    if (lowRisk.has(sub)) {
      return { allowed: true, risk: 'low', reason: 'Safe git read operation.' };
    }
    if (mediumRisk.has(sub)) {
      return { allowed: true, risk: 'medium', reason: 'Git write operation.' };
    }
    return { allowed: true, risk: 'medium', reason: `Git subcommand: ${sub}` };
  }

  // --- Swift ---
  if (command === 'swift') {
    const sub = String(args[0] || '');
    const safeSubs = new Set(['build', 'test', 'run', 'package', 'resolve']);
    if (safeSubs.has(sub)) {
      return { allowed: true, risk: 'low', reason: `Swift ${sub} command.` };
    }
    return { allowed: true, risk: 'medium', reason: 'Swift command.' };
  }

  // --- npm ---
  if (command === 'npm') {
    if (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'lint', 'start', 'dev'].includes(args[1]))) {
      return { allowed: true, risk: 'low', reason: 'NPM test/build/lint command.' };
    }
    if (args[0] === 'install' || args[0] === 'ci' || args[0] === 'create' || args[0] === 'init') {
      return { allowed: true, risk: 'medium', reason: 'Dependency install command.' };
    }
    // Harmless info / diagnostic sub-commands
    const infoSubs = new Set(['-v', '--version', 'version', 'ls', 'list', 'outdated', 'show',
      'info', 'view', 'explain', 'why', 'fund', 'audit', 'doctor', 'help', 'config', 'prefix',
      'root', 'bin', 'pkg', 'pack', 'search', 'uninstall', 'update', 'prune', 'dedupe',
      'rebuild', 'cache', 'exec', 'explore', 'link']);
    if (infoSubs.has(args[0])) {
      return { allowed: true, risk: 'low', reason: 'NPM informational/maintenance command.' };
    }
    // Allow arbitrary npm run scripts (not just a fixed list)
    if (args[0] === 'run' || args[0] === 'run-script') {
      return { allowed: true, risk: 'medium', reason: 'NPM run script.' };
    }
    return { allowed: true, risk: 'medium', reason: `NPM command: npm ${args.join(' ')}` };
  }

  // --- pnpm / yarn ---
  if (command === 'pnpm' || command === 'yarn') {
    if (args[0] === 'test' || args[0] === 'run' || args[0] === 'build' || args[0] === 'dev'
      || args[0] === 'start' || args[0] === 'lint') {
      return { allowed: true, risk: 'low', reason: `${command} dev command.` };
    }
    if (args[0] === 'install' || args[0] === 'add' || args[0] === 'remove' || args[0] === 'create'
      || args[0] === 'init' || args[0] === 'dlx') {
      return { allowed: true, risk: 'medium', reason: 'Dependency management command.' };
    }
    return { allowed: true, risk: 'medium', reason: `${command} command.` };
  }

  // --- npx ---
  if (command === 'npx') {
    const packageName = String(args[0] || '');
    if (!/^[a-zA-Z0-9@._/-]+$/.test(packageName)) {
      return { allowed: false, risk: 'high', reason: `Unsupported npx package token: ${packageName}` };
    }
    return { allowed: true, risk: 'medium', reason: 'npx command.' };
  }

  // --- open (macOS) ---
  if (command === 'open') {
    if (!Array.isArray(args) || args.length === 0) {
      return { allowed: false, risk: 'high', reason: 'open requires a target URL or file path.' };
    }
    // open is inherently limited on macOS — allow all flags.
    // Arguments after --args are passed to the target app and are not open's concern.
    return { allowed: true, risk: 'medium', reason: 'Open URL or file.' };
  }

  // --- Read-only shell commands ---
  if (['ls', 'pwd', 'cat', 'find', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep',
    'awk', 'sed', 'sort', 'uniq', 'tr', 'cut', 'diff', 'comm', 'tee',
    'which', 'type', 'command', 'exec', 'env', 'printenv', 'echo', 'printf',
    'basename', 'dirname', 'realpath', 'readlink', 'file', 'stat',
    'date', 'uname', 'whoami', 'id', 'hostname', 'df',
    'xargs', 'true', 'false', 'test', 'expr'].includes(command)) {
    return { allowed: true, risk: 'low', reason: 'Read-only / informational shell command.' };
  }

  // --- File system writes ---
  if (['mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'install', 'chmod'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'File system write command.' };
  }

  // --- Archive / compression ---
  if (['zip', 'unzip', 'tar', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', '7z'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Archive / compression command.' };
  }

  // --- Scripting / runtimes ---
  if (['node', 'python', 'python3', 'ruby', 'perl', 'sh', 'bash', 'zsh'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Script execution.' };
  }

  // --- Build tools & package managers ---
  if (['make', 'cmake', 'xcodebuild', 'xcrun', 'swiftc', 'clang', 'clang++', 'gcc', 'g++',
    'cargo', 'rustc', 'go', 'javac', 'java', 'gradle', 'mvn', 'dotnet',
    'pip', 'pip3', 'pipenv', 'poetry', 'bundler', 'gem', 'pod', 'cocoapods',
    'flutter', 'dart', 'deno', 'bun', 'brew', 'apt', 'apt-get', 'dnf', 'yum',
    'pacman', 'snap', 'port'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Build / package manager tool.' };
  }

  // --- Docker / containers ---
  if (['docker', 'docker-compose', 'podman', 'kubectl', 'helm',
    'terraform', 'vagrant', 'ansible'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Container / infrastructure tool.' };
  }

  // --- Database CLIs ---
  if (['sqlite3', 'psql', 'mysql', 'mongosh', 'mongo', 'redis-cli', 'pg_dump',
    'pg_restore', 'mysqldump'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Database CLI.' };
  }

  // --- Cloud CLIs ---
  if (['aws', 'gcloud', 'az', 'vercel', 'netlify', 'heroku', 'fly', 'flyctl',
    'railway', 'wrangler', 'firebase', 'supabase', 'amplify'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Cloud platform CLI.' };
  }

  // --- Process management ---
  if (['ps', 'kill', 'killall', 'lsof', 'top', 'htop', 'pgrep', 'pkill',
    'nohup', 'wait', 'sleep', 'timeout'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Process management.' };
  }

  // --- JSON / YAML / data processing ---
  if (['jq', 'yq', 'xmllint', 'csvtool', 'bc', 'seq', 'yes'].includes(command)) {
    return { allowed: true, risk: 'low', reason: 'Data processing utility.' };
  }

  // --- Linters / formatters / testing ---
  if (['eslint', 'prettier', 'black', 'flake8', 'pylint', 'mypy', 'rubocop',
    'gofmt', 'goimports', 'rustfmt', 'clippy', 'tsc',
    'jest', 'pytest', 'mocha', 'vitest', 'playwright'].includes(command)) {
    return { allowed: true, risk: 'low', reason: 'Linter / formatter / test runner.' };
  }

  // --- Image / media tools ---
  if (['convert', 'magick', 'sips', 'ffmpeg', 'ffprobe', 'optipng', 'pngquant',
    'svgo', 'cwebp'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Image / media processing.' };
  }

  // --- Version managers ---
  if (['nvm', 'fnm', 'volta', 'rbenv', 'pyenv', 'asdf', 'mise', 'n'].includes(command)) {
    return { allowed: true, risk: 'low', reason: 'Version manager.' };
  }

  // --- Misc dev utilities ---
  if (['tree', 'less', 'more', 'strings', 'od', 'hexdump', 'xxd',
    'md5', 'md5sum', 'shasum', 'sha256sum', 'openssl',
    'code', 'pbcopy', 'pbpaste', 'nc', 'ncat',
    'ping', 'nslookup', 'dig', 'host', 'traceroute', 'ifconfig',
    'mdfind', 'defaults', 'plutil', 'sw_vers', 'system_profiler',
    'codesign', 'hdiutil', 'ditto', 'lipo', 'otool', 'nm',
    'strip', 'dsymutil', 'atos', 'xcpretty'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Developer utility.' };
  }

  // --- Network (limited) ---
  if (['curl', 'wget'].includes(command)) {
    return { allowed: true, risk: 'medium', reason: 'Network request (sandboxed to workspace).' };
  }

  // --- SSH / SCP (gated) ---
  if (['ssh', 'scp', 'rsync'].includes(command)) {
    return { allowed: 'gated', risk: 'high', reason: `${command} requires explicit approval.` };
  }

  // --- Catch-all: allow anything not hard-blocked above at medium risk ---
  // The blocklist at the top catches truly dangerous commands (sudo, launchctl, etc.).
  // Everything else is assumed safe enough for an autonomous agent.
  return { allowed: true, risk: 'medium', reason: `Unlisted command allowed: ${command}` };
}

function withMinimumRisk(baseRisk, minimumRisk) {
  const order = ['low', 'medium', 'high'];
  return order.indexOf(baseRisk) >= order.indexOf(minimumRisk) ? baseRisk : minimumRisk;
}

function evaluateActionPolicy(action) {
  const tool = action.tool;

  if (tool === 'list_files' || tool === 'read_file' || tool === 'search_files') {
    return { allowed: true, effectiveRisk: withMinimumRisk(action.risk_level, 'low'), reason: 'Read-only file action.' };
  }

  if (tool === 'write_file' || tool === 'append_file' || tool === 'patch_file') {
    return { allowed: true, effectiveRisk: withMinimumRisk(action.risk_level, 'medium'), reason: 'File write action.' };
  }

  if (tool === 'run_command') {
    const command = String(action.exact_args.command || '').trim();
    const args = Array.isArray(action.exact_args.args)
      ? action.exact_args.args.map((value) => String(value))
      : [];
    const lowerCommand = command.toLowerCase();
    const lowerArgs = args.map((value) => value.toLowerCase());
    const inlineScriptIndex = lowerArgs.findIndex((value) => value === '-c' || value === '-e');
    if (
      (lowerCommand === 'python' || lowerCommand === 'python3' || lowerCommand === 'node')
      && inlineScriptIndex >= 0
      && inlineScriptIndex + 1 < args.length
      && String(args[inlineScriptIndex + 1]).toLowerCase().includes('playwright')
    ) {
      return {
        allowed: false,
        effectiveRisk: 'medium',
        reason: 'Inline Playwright scripts are brittle. Use run_playwright for browser verification instead.',
      };
    }
    const policy = commandPolicy(command, args);
    if (policy.allowed === false) {
      return { allowed: false, effectiveRisk: 'high', reason: policy.reason };
    }
    if (policy.allowed === 'gated') {
      return {
        allowed: 'gated',
        effectiveRisk: 'high',
        reason: policy.reason,
      };
    }
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, policy.risk),
      reason: policy.reason,
    };
  }

  if (tool === 'run_playwright' || tool === 'browser_launch' || tool === 'browser_action' || tool === 'browser_close') {
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, 'medium'),
      reason: 'Browser automation requires approval.',
    };
  }

  if (tool === 'analyze_image') {
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, 'low'),
      reason: 'Image analysis for screenshots/attachments.',
    };
  }

  if (tool === 'web_search') {
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, 'low'),
      reason: 'Web search (read-only network lookup).',
    };
  }

  if (tool === 'web_scrape') {
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, 'low'),
      reason: 'Web scrape (read-only page fetch).',
    };
  }

  // Integration tools — GitHub, webhook, email, safe HTTP
  const integrationTools = new Set([
    'github_list_issues', 'github_get_issue', 'github_create_issue',
    'github_create_pr', 'github_get_pr', 'github_pr_comments',
    'github_reply_review', 'github_ci_status', 'github_add_comment',
    'notify_webhook', 'send_email', 'http_get',
  ]);
  if (integrationTools.has(tool)) {
    const readOnlyGH = new Set(['github_list_issues', 'github_get_issue', 'github_get_pr', 'github_pr_comments', 'github_ci_status', 'http_get']);
    const risk = readOnlyGH.has(tool) ? 'low' : 'medium';
    return {
      allowed: true,
      effectiveRisk: withMinimumRisk(action.risk_level, risk),
      reason: `Integration tool: ${tool}.`,
    };
  }

  // No-side-effect tools
  if (tool === 'think') {
    return { allowed: true, effectiveRisk: 'low', reason: 'Reasoning tool (no side effects).' };
  }

  // HTTP request tool
  if (tool === 'http_request') {
    return { allowed: true, effectiveRisk: withMinimumRisk(action.risk_level, 'low'), reason: 'HTTP request.' };
  }

  // Delegate subagent tool
  if (tool === 'delegate') {
    return { allowed: true, effectiveRisk: withMinimumRisk(action.risk_level, 'low'), reason: 'Specialist subagent delegation.' };
  }

  // Explicit safeguard rejection tool
  if (tool === 'safeguard_rejected') {
    return { allowed: true, effectiveRisk: 'low', reason: 'Explicit safeguard rejection passthrough.' };
  }

  // Belt-and-suspenders: convert directory-creation pseudo-tools to run_command mkdir -p
  // in case normalizeAction didn't already handle it (e.g. when called directly or via
  // a code path that bypasses the standard normalization chain).
  const _dirCreateNames = new Set([
    'createdirectory', 'makedirectory', 'createdir', 'makedir',
    'create_directory', 'make_directory', 'mkdir_p',
    'createfolder', 'makefolder', 'create_folder', 'make_folder',
  ]);
  const _noUnderscores = tool.replace(/_/g, '');
  if (_dirCreateNames.has(tool) || _dirCreateNames.has(_noUnderscores)) {
    const _ea = action.exact_args || {};
    const _dirPath = _ea.path || _ea.directory || _ea.dir || _ea.folder || _ea.name || _ea.target || '';
    // Mutate the action in-place so the caller uses the corrected tool/args
    action.tool = 'run_command';
    action.exact_args = {
      command: 'mkdir',
      args: ['-p', _dirPath].filter(Boolean),
      cwd: _ea.cwd || '',
      timeout_ms: 10000,
    };
    return { allowed: true, effectiveRisk: 'medium', reason: 'Directory creation normalised to mkdir -p.' };
  }

  // Last-resort recovery was removed because mutating hallucinated tools into shell commands
  // throws an unhelpful 'spawn ENOENT' instead of the native 'Unsupported tool' teaching message.

  return { allowed: false, effectiveRisk: 'high', reason: `Unsupported tool: ${tool}` };
}

async function runCommand({
  command,
  args,
  cwd,
  timeoutMs = 180000,
  runId = '',
}) {
  return new Promise((resolve, reject) => {
    if (isRunStopRequested(runId)) {
      reject(new StopRequestedError(getRunStopReason(runId) || 'Run stopped by user.'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: false,
      env: {
        ...process.env,
        PATH: getShellPath(),
        CI: '1',
      },
    });
    registerRunChild(runId, child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopRequested = false;
    let settled = false;

    const settle = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (stopTimer) clearInterval(stopTimer);
      unregisterRunChild(runId, child);
      // Smart truncation: keep first half + last half so error output at
      // the end (where most diagnostics appear) is preserved.
      const OUTPUT_LIMIT = 120000;
      const HALF = OUTPUT_LIMIT / 2;
      if (stdout.length > OUTPUT_LIMIT) {
        const skipped = stdout.length - OUTPUT_LIMIT;
        stdout = `${stdout.slice(0, HALF)}\n\n...[truncated ${skipped} chars]...\n\n${stdout.slice(-HALF)}`;
      }
      if (stderr.length > OUTPUT_LIMIT) {
        const skipped = stderr.length - OUTPUT_LIMIT;
        stderr = `${stderr.slice(0, HALF)}\n\n...[truncated ${skipped} chars]...\n\n${stderr.slice(-HALF)}`;
      }
      resolve({
        exitCode: exitCode ?? null,
        signal: signal || null,
        timedOut,
        stopped: stopRequested || isRunStopRequested(runId),
        stdout,
        stderr,
      });
    };

    // Hard cap: 5 minutes max per command.
    const cappedTimeout = Math.max(1000, Math.min(timeoutMs, 300000));
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { }
    }, cappedTimeout);

    // SIGKILL fallback: if SIGTERM doesn't clean up within 5s (e.g. backgrounded
    // children holding stdout open), force-kill and settle immediately.
    let killTimer;
    const scheduleForceKill = () => {
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { }
        // Settle even if stdio is still open — the grandchild is orphaned anyway
        settle(null, 'SIGKILL');
      }, 5000);
    };

    const stopTimer = runId
      ? setInterval(() => {
        if (isRunStopRequested(runId) && !child.killed) {
          stopRequested = true;
          try { child.kill('SIGTERM'); } catch { }
        }
      }, 300)
      : null;

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 500000) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 500000) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (stopTimer) clearInterval(stopTimer);
      unregisterRunChild(runId, child);
      reject(error);
    });

    // 'exit' fires when the process exits, even if stdio is still open.
    // This handles the case where bash exits but a backgrounded grandchild
    // (e.g. python3 -m http.server &) keeps stdout open.
    child.on('exit', (exitCode, signal) => {
      if (timedOut || stopRequested) {
        // After timeout/stop SIGTERM, schedule force-kill fallback
        scheduleForceKill();
      }
      // Give 'close' 2 seconds to fire (for normal commands). If it doesn't
      // (stdio held open by grandchild), settle from 'exit' directly.
      setTimeout(() => settle(exitCode, signal), 2000);
    });

    child.on('close', (exitCode, signal) => {
      settle(exitCode, signal);
    });
  });
}

function sanitizeProfileName(rawName) {
  const value = String(rawName || 'default').trim().toLowerCase();
  const cleaned = value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

async function pageHasSelector(page, selector) {
  const query = String(selector || '').trim();
  if (!query) {
    return false;
  }
  try {
    const handle = await page.$(query);
    return Boolean(handle);
  } catch {
    return false;
  }
}

async function isLikelyLoginPage(page) {
  const currentUrl = String(page.url() || '').toLowerCase();
  if (/(signin|sign-in|log-in|login|auth)/.test(currentUrl)) {
    return true;
  }

  const selectors = [
    'input[type="password"]',
    'input[name*="password" i]',
    'form[action*="login" i]',
    'form[action*="signin" i]',
    'a[href*="login" i]',
    'a[href*="signin" i]',
  ];
  for (const selector of selectors) {
    if (await pageHasSelector(page, selector)) {
      return true;
    }
  }
  return false;
}

async function waitForManualLogin({
  page,
  runId = '',
  loginSuccessSelector = '',
  postLoginUrlContains = '',
  timeoutMs = 300000,
}) {
  const startedAt = Date.now();
  const successSelector = String(loginSuccessSelector || '').trim();
  const expectedUrlToken = String(postLoginUrlContains || '').trim().toLowerCase();

  while ((Date.now() - startedAt) < timeoutMs) {
    throwIfRunStopped(runId);
    const currentUrl = String(page.url() || '').toLowerCase();
    const hasLoginSignals = await isLikelyLoginPage(page);
    const successBySelector = successSelector
      ? await pageHasSelector(page, successSelector)
      : !hasLoginSignals;
    const successByUrl = expectedUrlToken ? currentUrl.includes(expectedUrlToken) : true;
    if (successBySelector && successByUrl) {
      return true;
    }
    await page.waitForTimeout(1000);
  }

  return false;
}

async function runPlaywrightTool(args, workspaceRoot, runId = '') {
  throwIfRunStopped(runId);
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    let hint = '';
    if (url.startsWith('chrome://')) {
      hint = ' Chrome internal pages (chrome://) are not accessible via Playwright. Use run_playwright with extension_path to load and test a Chrome extension on a real page.';
    } else if (url.startsWith('file://') || url.startsWith('/') || url.endsWith('.html')) {
      // Extract the file path and suggest the correct server approach
      const filePath = url.replace(/^file:\/\//, '');
      const dir = filePath.includes('/') ? filePath.replace(/\/[^/]+$/, '') : '.';
      const file = filePath.includes('/') ? filePath.replace(/.*\//, '') : filePath;
      hint = ` file:// URLs are not supported. To test a local HTML file you MUST start an HTTP server first, then use the http:// URL. Recovery steps:\n1. run_command: {"command":"bash","args":["-c","lsof -ti:8081 | xargs kill -9 2>/dev/null; sleep 0.3; python3 -m http.server 8081 --directory ${dir} &"]}\n2. run_playwright: {"url":"http://localhost:8081/${file}","headless":true}`;
    }
    throw new Error(`Playwright requires http/https URL. Received: ${url}.${hint}`);
  }

  let playwright;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    playwright = require('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run: npm install playwright');
  }

  const timeoutMs = clampNumber(Number(args.timeout_ms || 90000), 1000, 240000, 90000);
  const interactiveLogin = args.interactive_login === true;
  const autoPromptLogin = args.auto_prompt_login !== false;
  const loginWaitMs = clampNumber(Number(args.login_wait_ms || 300000), 15000, 900000, 300000);
  const loginSuccessSelector = typeof args.login_success_selector === 'string' ? args.login_success_selector.trim() : '';
  const postLoginUrlContains = typeof args.post_login_url_contains === 'string' ? args.post_login_url_contains.trim() : '';
  const profileName = sanitizeProfileName(args.profile_name || 'default');
  const profileDir = path.join(app.getPath('userData'), 'browser-profiles', profileName);
  await fs.mkdir(profileDir, { recursive: true });

  // Chrome extension loading support
  const extensionPath = typeof args.extension_path === 'string' ? args.extension_path.trim() : '';
  const resolvedExtensionPath = extensionPath
    ? resolveWorkspacePath(workspaceRoot, extensionPath)
    : '';

  // evaluate_js: run custom JS on the page and return the result (for verifying extensions, DOM state, etc.)
  const evaluateJs = typeof args.evaluate_js === 'string' ? args.evaluate_js.trim() : '';

  // Extensions require headed mode (Chrome extensions don't work in old headless)
  const forceHeaded = !!resolvedExtensionPath;
  const initialHeadless = forceHeaded ? false : (interactiveLogin ? false : (args.headless !== false));

  const launchPersistentContext = async (headless) => {
    const launchOptions = { headless };
    if (resolvedExtensionPath) {
      launchOptions.headless = false; // extensions always need headed mode
      // Use real Chrome instead of bundled Chromium — Playwright's Chromium
      // ("Chrome for Testing") doesn't support loading MV3 extensions.
      launchOptions.channel = 'chrome';
      launchOptions.args = [
        `--disable-extensions-except=${resolvedExtensionPath}`,
        `--load-extension=${resolvedExtensionPath}`,
      ];
    }
    return playwright.chromium.launchPersistentContext(profileDir, launchOptions);
  };
  let contextIsHeadless = initialHeadless;
  let context = await launchPersistentContext(contextIsHeadless);

  let page = context.pages()[0] || await context.newPage();
  let loginPrompted = false;
  let loginCompleted = false;
  const eventOwner = normalizeOwner(args.owner) || 'research';

  // Capture browser console errors and uncaught page errors
  const consoleErrors = [];
  const attachConsoleListeners = (p) => {
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(truncate(msg.text(), 400));
    });
    p.on('pageerror', (err) => {
      consoleErrors.push(truncate(String(err.message || err), 400));
    });
  };
  attachConsoleListeners(page);

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    throwIfRunStopped(runId);

    const ensureHeadedContext = async () => {
      if (!contextIsHeadless) {
        return;
      }
      const reopenUrl = String(page.url() || url).trim() || url;
      try {
        await context.close();
      } catch {
        // Ignore close errors.
      }
      context = await launchPersistentContext(false);
      contextIsHeadless = false;
      page = context.pages()[0] || await context.newPage();
      attachConsoleListeners(page);
      await page.goto(reopenUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    };

    const maybePromptLogin = async (reason = 'Login required to continue browser automation.') => {
      loginPrompted = true;
      await ensureHeadedContext();
      if (runId) {
        broadcastWatchEvent(runId, {
          type: 'login_required',
          owner: eventOwner,
          summary: reason,
        }, {
          state: 'running',
          workspaceRoot,
        });
      }
      const ok = await waitForManualLogin({
        page,
        runId,
        loginSuccessSelector,
        postLoginUrlContains,
        timeoutMs: loginWaitMs,
      });
      if (!ok) {
        throw new Error('Login required but not completed in time. Please run again and finish login when prompted.');
      }
      loginCompleted = true;
      if (runId) {
        broadcastWatchEvent(runId, {
          type: 'login_completed',
          owner: eventOwner,
          summary: 'Login detected. Continuing automation.',
        }, {
          state: 'running',
          workspaceRoot,
        });
      }
    };

    if (interactiveLogin && (await isLikelyLoginPage(page))) {
      await maybePromptLogin('Please complete login in the opened browser window.');
    }

    if (typeof args.wait_for_selector === 'string' && args.wait_for_selector.trim().length > 0) {
      try {
        await page.waitForSelector(args.wait_for_selector.trim(), { timeout: timeoutMs });
      } catch (error) {
        const loginLikely = await isLikelyLoginPage(page);
        if (loginLikely && (interactiveLogin || autoPromptLogin)) {
          await maybePromptLogin('Please log in to continue this task.');
          await page.waitForSelector(args.wait_for_selector.trim(), { timeout: timeoutMs });
        } else {
          throw error;
        }
      }
    }
    throwIfRunStopped(runId);

    const title = await page.title();
    const finalUrl = page.url();
    const h1 = await page.$$eval('h1', (nodes) => nodes
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8));
    const links = await page.$$eval('a[href]', (nodes) => nodes
      .map((node) => ({
        text: (node.textContent || '').trim(),
        href: node.getAttribute('href') || '',
      }))
      .filter((item) => item.href)
      .slice(0, 20));

    let extractedText = '';
    if (typeof args.extract_selector === 'string' && args.extract_selector.trim().length > 0) {
      try {
        extractedText = await page.$eval(
          args.extract_selector.trim(),
          (node) => (node.textContent || '').trim(),
        );
      } catch {
        extractedText = '';
      }
    }

    let screenshotPath = '';
    if (typeof args.screenshot_path === 'string' && args.screenshot_path.trim().length > 0) {
      const target = resolveWorkspacePath(workspaceRoot, args.screenshot_path.trim());
      await fs.mkdir(path.dirname(target), { recursive: true });
      await page.screenshot({
        path: target,
        fullPage: args.full_page !== false,
      });
      screenshotPath = path.relative(workspaceRoot, target);
    }
    throwIfRunStopped(runId);

    // Run custom JS assertions on the page (for verifying extensions, DOM state, etc.)
    let evaluateJsResult = '';
    if (evaluateJs) {
      try {
        // Wait a moment for extension content scripts to inject
        if (resolvedExtensionPath) {
          await page.waitForTimeout(2000);
        }
        // eslint-disable-next-line no-eval
        const result = await page.evaluate(evaluateJs);
        evaluateJsResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      } catch (evalError) {
        evaluateJsResult = `JS evaluation error: ${String(evalError.message || evalError)}`;
      }
    }

    // Brief pause to capture any async JS errors that fire after initial load
    await page.waitForTimeout(1200);
    throwIfRunStopped(runId);

    // Detect if extension loaded successfully by checking for extension-injected elements
    let extensionDetected = false;
    if (resolvedExtensionPath) {
      try {
        // Give extension content scripts a moment to run
        await page.waitForTimeout(1000);
        // Check if any extension content script injected elements or modified the page
        extensionDetected = await page.evaluate(() => {
          // Check common extension injection patterns
          const extElements = document.querySelectorAll('[data-extension], [class*="ext-"], [id*="ext-"]');
          const shadowRoots = document.querySelectorAll('*');
          let hasShadowDom = false;
          for (const el of shadowRoots) {
            if (el.shadowRoot) { hasShadowDom = true; break; }
          }
          // Also check if chrome.runtime is available (content script context)
          const hasRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
          return !!(extElements.length > 0 || hasShadowDom || hasRuntime);
        });
      } catch {
        extensionDetected = false;
      }
    }

    const resultData = {
      url: finalUrl,
      title,
      h1,
      links,
      extractedText,
      screenshotPath,
      loginPrompted,
      loginCompleted,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors : [],
      consoleErrorCount: consoleErrors.length,
    };
    if (resolvedExtensionPath) {
      resultData.extensionLoaded = true;
      resultData.extensionDetected = extensionDetected;
      resultData.extensionPath = extensionPath;
    }
    if (evaluateJsResult) {
      resultData.evaluateJsResult = evaluateJsResult;
    }

    const summaryParts = [`Browsed ${finalUrl}`];
    if (consoleErrors.length > 0) {
      summaryParts.push(`| ⚠️ ${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 3).join(' | ')}`);
    } else {
      summaryParts.push('| ✅ zero console errors');
    }
    if (resolvedExtensionPath) {
      summaryParts.push(extensionDetected ? '(extension active)' : '(extension loaded but not detected on page)');
    }
    if (evaluateJsResult) {
      summaryParts.push(`| JS result: ${truncate(evaluateJsResult, 200)}`);
    }

    if (screenshotPath) {
      summaryParts.push(`| 📸 Screenshot saved to: ${screenshotPath}`);
    }

    return {
      ok: true,
      summary: summaryParts.join(' '),
      output: JSON.stringify(resultData, null, 2) + (screenshotPath ? `\n\n[NOTE: You MUST use the exact path "${screenshotPath}" if you want to analyze this screenshot.]` : ''),
      metadata: {
        kind: 'playwright-run',
        url: finalUrl,
        consoleErrorCount: consoleErrors.length,
        hasConsoleErrors: consoleErrors.length > 0,
        screenshotPath: screenshotPath || '',
        extensionLoaded: Boolean(resolvedExtensionPath),
      },
    };
  } finally {
    await context.close();
  }
}

async function executeAction(action, workspaceRoot, runId = '', allowRisky = false, context = {}) {
  throwIfRunStopped(runId);
  const tool = action.tool;
  const args = action.exact_args;
  const owner = normalizeOwner(action.owner) || inferOwnerFromAction(action);

  if (tool === 'list_files') {
    const target = resolveWorkspacePath(workspaceRoot, String(args.path || '.'));
    const maxDepth = Number.isInteger(args.max_depth) ? Math.min(Math.max(args.max_depth, 0), 5) : 2;
    const files = await listWorkspaceFiles(target, maxDepth, 250);
    return {
      ok: true,
      summary: `Listed ${files.length} entries in ${path.relative(workspaceRoot, target) || '.'}`,
      output: files.join('\n'),
      metadata: {
        path: path.relative(workspaceRoot, target) || '.',
        kind: 'directory-list',
      },
    };
  }

  if (tool === 'read_file') {
    const resolvedPath = await resolveExistingWorkspacePath(workspaceRoot, String(args.path || ''));
    const target = resolvedPath.target;
    const buffer = await fs.readFile(target);
    const relPath = path.relative(workspaceRoot, target);
    const mimeType = inferImageMime(target, buffer);
    if (mimeType) {
      const dims = readImageDimensions(target, buffer);
      const maxInlineBytes = 1_800_000;
      let visionSummary = '';
      const settingsForVision = ensureObject(context.settings);
      const modelForVision = String(context.model || settingsForVision.model || '').trim();
      if (settingsForVision.apiKey && modelForVision) {
        let visionBuffer = buffer;
        if (visionBuffer.length > 2_000_000) {
          try {
            const resized = nativeImage.createFromBuffer(visionBuffer).resize({ width: Math.min(1280, dims.width || 1280) });
            const resizedPng = resized.toPNG();
            if (resizedPng && resizedPng.length > 0) {
              visionBuffer = resizedPng;
            }
          } catch {
            // Keep original.
          }
        }
        if (visionBuffer.length <= 5_000_000) {
          try {
            visionSummary = await runVisionAnalysis({
              settings: settingsForVision,
              model: modelForVision,
              prompt: 'Describe this screenshot for debugging. Focus on visible errors, layout issues, and missing UI pieces.',
              mimeType: inferImageMime(target, visionBuffer) || mimeType,
              imageBase64: visionBuffer.toString('base64'),
            });
          } catch (err) {
            visionSummary = `Image auto-analysis unavailable: ${String(err.message || err)}`;
          }
        }
      }
      const outputPayload = {
        kind: 'image',
        path: relPath,
        mimeType,
        sizeBytes: buffer.length,
        width: dims.width,
        height: dims.height,
        note: 'Use analyze_image for visual interpretation of this screenshot.',
      };
      if (visionSummary) {
        outputPayload.analysis = visionSummary;
      }
      if (buffer.length <= maxInlineBytes) {
        outputPayload.base64 = buffer.toString('base64');
      }
      return {
        ok: true,
        summary: `Read image ${relPath} (${dims.width || '?'}x${dims.height || '?'}, ${buffer.length} bytes)`,
        output: JSON.stringify(outputPayload, null, 2),
        metadata: {
          path: relPath,
          kind: 'image-read',
          image: true,
          mimeType,
          sizeBytes: buffer.length,
        },
      };
    }
    if (looksBinary(buffer)) {
      return {
        ok: true,
        summary: `Read binary file ${relPath}`,
        output: JSON.stringify({
          kind: 'binary',
          path: relPath,
          sizeBytes: buffer.length,
          note: 'Binary file detected. Use tool-specific handlers instead of text parsing.',
        }, null, 2),
        metadata: {
          path: relPath,
          kind: 'binary-read',
          sizeBytes: buffer.length,
        },
      };
    }
    const text = buffer.toString('utf8');
    if (buffer.length > 300000) {
      const preview = makeLargeTextPreview(text);
      return {
        ok: true,
        summary: `Read large text file ${relPath} (truncated preview)`,
        output: preview,
        metadata: {
          path: relPath,
          kind: 'file-read-truncated',
          truncated: true,
          sizeBytes: buffer.length,
        },
      };
    }
    return {
      ok: true,
      summary: `Read ${relPath}`,
      output: text,
      metadata: {
        path: relPath,
        kind: 'file-read',
        requestedPath: resolvedPath.requestedPath,
        fallbackPathResolved: resolvedPath.fallbackUsed || false,
      },
    };
  }

  if (tool === 'analyze_image') {
    const resolvedPath = await resolveExistingWorkspacePath(workspaceRoot, String(args.path || ''));
    const target = resolvedPath.target;
    const buffer = await fs.readFile(target);
    const mimeType = inferImageMime(target, buffer);
    if (!mimeType) {
      throw new Error(`analyze_image expects an image file. Received: ${path.relative(workspaceRoot, target)}`);
    }
    const dims = readImageDimensions(target, buffer);
    let visionBuffer = buffer;
    if (visionBuffer.length > 2_000_000) {
      try {
        const resized = nativeImage.createFromBuffer(visionBuffer).resize({ width: Math.min(1280, dims.width || 1280) });
        const resizedPng = resized.toPNG();
        if (resizedPng && resizedPng.length > 0) {
          visionBuffer = resizedPng;
        }
      } catch {
        // Keep original buffer if resize fails.
      }
    }
    if (visionBuffer.length > 5_000_000) {
      throw new Error(`Image is too large for analysis: ${path.relative(workspaceRoot, target)} (${visionBuffer.length} bytes).`);
    }

    const settings = ensureObject(context.settings);
    const model = String(context.model || settings.model || '').trim();
    if (!model) {
      throw new Error('No model selected for image analysis.');
    }
    const prompt = String(args.prompt || '').trim() || 'Analyze this screenshot for UI issues, bugs, and missing details.';
    const analysis = await runVisionAnalysis({
      settings,
      model,
      prompt,
      mimeType: inferImageMime(target, visionBuffer) || mimeType,
      imageBase64: visionBuffer.toString('base64'),
    });
    return {
      ok: true,
      summary: `Analyzed image ${path.relative(workspaceRoot, target)}`,
      output: analysis,
      metadata: {
        path: path.relative(workspaceRoot, target),
        kind: 'image-analysis',
        width: dims.width,
        height: dims.height,
        sizeBytes: buffer.length,
        analyzedBytes: visionBuffer.length,
        requestedPath: resolvedPath.requestedPath,
        fallbackPathResolved: resolvedPath.fallbackUsed || false,
      },
    };
  }

  if (tool === 'write_file' || tool === 'append_file') {
    const target = resolveWorkspacePath(workspaceRoot, String(args.path || ''));
    const content = String(args.content || '');

    // Block fabricated test/verification result files
    const filename = path.basename(target).toLowerCase();
    const fabricationPatterns = [
      'manualtesting', 'manual_testing', 'manual-testing',
      'testingresults', 'testing_results', 'testing-results',
      'test_results', 'test-results', 'testresults',
      'qaresults', 'qa_results', 'qa-results',
      'verificationresults', 'verification_results', 'verification-results',
      'manual_verification', 'manual-verification',
    ];
    if (fabricationPatterns.some((p) => filename.includes(p))) {
      throw new Error(`Blocked: "${path.basename(target)}" looks like a fabricated test result file. Run real tests with run_command instead of writing result documents.`);
    }

    let before = '';
    let existed = false;

    try {
      before = await fs.readFile(target, 'utf8');
      existed = true;
    } catch {
      existed = false;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    if (tool === 'write_file') {
      await fs.writeFile(target, content, 'utf8');
    } else {
      await fs.appendFile(target, content, 'utf8');
    }

    return {
      ok: true,
      summary: `${tool === 'write_file' ? 'Wrote' : 'Appended'} ${path.relative(workspaceRoot, target)}`,
      output: tool === 'write_file'
        ? `Previous length: ${before.length}, New length: ${content.length}`
        : `Appended length: ${content.length}`,
      rollback: existed
        ? `Restore previous file content for ${path.relative(workspaceRoot, target)} (${before.length} chars).`
        : `Delete created file ${path.relative(workspaceRoot, target)}.`,
      metadata: {
        path: path.relative(workspaceRoot, target),
        kind: tool === 'write_file' ? 'file-write' : 'file-append',
        existedBefore: existed,
        createdNewFile: !existed,
      },
    };
  }

  if (tool === 'run_command') {
    const command = String(args.command || '').trim();
    const commandArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];
    const commandPolicyResult = commandPolicy(command, commandArgs);
    if (commandPolicyResult.allowed === false) {
      throw new Error(commandPolicyResult.reason);
    }
    // Gated commands (git push, ssh, scp, rsync): allow if auto mode, if this run
    // has push approval, or if the user temporarily unlocked remote access.
    if (commandPolicyResult.allowed === 'gated') {
      const remoteGranted = isSecurityGrantActive(context?.securityControls?.remoteAccessUntil);
      if (!allowRisky && !remoteGranted && !isPushApproved(runId)) {
        throw new Error(`${command} requires explicit approval for this run. Approve in the UI, or use Auto Mode for full autonomy.`);
      }
    }

    // Keep "open" safe: only allow http(s) URLs or files inside workspace.
    if (command === 'open') {
      if (commandArgs.length === 0) {
        throw new Error('open requires a target URL or file path.');
      }
      // Find the non-flag target argument (skip flags and their values like -a AppName, -b bundleId)
      const flagsWithValues = new Set(['-a', '-b']);
      let target = '';
      for (let i = 0; i < commandArgs.length; i++) {
        const a = String(commandArgs[i]);
        if (flagsWithValues.has(a)) { i++; continue; }  // skip flag + its value
        if (a.startsWith('-')) continue;                  // skip standalone flags
        target = a.trim();
        break;
      }
      if (target && /^https?:\/\//i.test(target)) {
        // URL target — allowed as-is.
      } else if (target && /^file:\/\//i.test(target)) {
        const localPath = decodeURI(target.replace(/^file:\/\//i, ''));
        const resolved = resolveWorkspacePath(workspaceRoot, localPath);
        const idx = commandArgs.indexOf(target);
        if (idx >= 0) commandArgs[idx] = resolved;
      } else if (target) {
        const resolved = resolveWorkspacePath(workspaceRoot, target);
        const idx = commandArgs.indexOf(target);
        if (idx >= 0) commandArgs[idx] = resolved;
      }
    }

    const requestedCwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd : '.';
    let cwd = resolveWorkspacePath(workspaceRoot, requestedCwd);
    // Cap command timeout: default 3 min, max 5 min. The old 30-min cap
    // let a single stuck command block the entire execution pipeline.
    const timeoutMs = Number.isInteger(args.timeout_ms)
      ? Math.min(Math.max(args.timeout_ms, 1000), 300000)
      : 180000;
    let result = await runCommand({
      command,
      args: commandArgs,
      cwd,
      timeoutMs,
      runId,
    });
    if (result.stopped) {
      throw new StopRequestedError(getRunStopReason(runId) || 'Run stopped by user request.');
    }

    // Self-heal common case: workspace points at home folder that has a broken
    // package.json, but the command was intended for a project subfolder.
    const combinedError = `${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase();
    if (result.exitCode !== 0 && !result.timedOut && combinedError.includes('invalid package config')) {
      const fallbackCwd = await findFallbackCwdForCommand(command, commandArgs, workspaceRoot, cwd);
      if (fallbackCwd && path.resolve(fallbackCwd) !== path.resolve(cwd)) {
        const retry = await runCommand({
          command,
          args: commandArgs,
          cwd: fallbackCwd,
          timeoutMs,
          runId,
        });
        if (retry.stopped) {
          throw new StopRequestedError(getRunStopReason(runId) || 'Run stopped by user request.');
        }
        if (retry.exitCode === 0 || (retry.stdout || '').trim().length > 0) {
          const from = path.relative(workspaceRoot, cwd) || '.';
          const to = path.relative(workspaceRoot, fallbackCwd) || '.';
          cwd = fallbackCwd;
          result = {
            ...retry,
            stdout: [`Auto-retry: switched working folder from "${from}" to "${to}" due invalid package config.`, retry.stdout || '']
              .filter(Boolean)
              .join('\n'),
          };
        }
      }
    }

    const discoveryCommands = new Set(['find', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc']);
    const hasUsefulOutput = (result.stdout || '').trim().length > 0;
    const nonFatalDiscoveryFailure = discoveryCommands.has(command) && !result.timedOut && hasUsefulOutput;

    // For 'open' command, surface what was actually opened
    let openTarget = '';
    if (command === 'open') {
      const flagsWithValues = new Set(['-a', '-b']);
      for (let i = 0; i < commandArgs.length; i++) {
        const a = String(commandArgs[i]);
        if (flagsWithValues.has(a)) { i++; continue; }
        if (a.startsWith('-')) continue;
        openTarget = a.trim();
        break;
      }
    }

    return {
      ok: (result.exitCode === 0 && !result.timedOut) || nonFatalDiscoveryFailure,
      summary: command === 'open' && openTarget
        ? `Opened: ${openTarget}`
        : `Ran ${command} ${commandArgs.join(' ')}`.trim(),
      output: [
        command === 'open' && openTarget ? `>>> OPENED: ${openTarget}` : '',
        `cwd: ${path.relative(workspaceRoot, cwd) || '.'}`,
        `exitCode: ${result.exitCode}`,
        nonFatalDiscoveryFailure ? 'nonFatal: true (discovery command returned partial results)' : '',
        result.timedOut ? 'timedOut: true' : '',
        result.stdout ? `stdout:\n${truncate(result.stdout, 3000)}` : '',
        result.stderr ? `stderr:\n${truncate(result.stderr, 3000)}` : '',
      ].filter(Boolean).join('\n\n'),
      metadata: {
        command,
        args: commandArgs,
        cwd: path.relative(workspaceRoot, cwd) || '.',
        kind: 'command',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // patch_file — surgical search-and-replace in a file (avoids rewriting entire files)
  // ---------------------------------------------------------------------------
  if (tool === 'patch_file') {
    const target = resolveWorkspacePath(workspaceRoot, String(args.path || ''));
    const search = String(args.search || '');
    const replace = typeof args.replace === 'string' ? args.replace : '';
    if (!search) {
      throw new Error('patch_file requires a non-empty "search" string.');
    }
    let content;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch (err) {
      throw new Error(`Cannot patch — file not found: ${path.relative(workspaceRoot, target)}`);
    }
    const occurrences = content.split(search).length - 1;
    if (occurrences === 0) {
      // Try case-insensitive fallback for small typos
      const searchLower = search.toLowerCase();
      const contentLower = content.toLowerCase();
      if (contentLower.includes(searchLower)) {
        // Found case-insensitive match — do the replacement
        const idx = contentLower.indexOf(searchLower);
        const before = content.slice(0, idx);
        const after = content.slice(idx + search.length);
        const patched = before + replace + after;
        await fs.writeFile(target, patched, 'utf8');
        return {
          ok: true,
          summary: `Patched ${path.relative(workspaceRoot, target)} (1 case-insensitive match)`,
          output: `Replaced (case-insensitive) 1 occurrence. File size: ${content.length} → ${patched.length} chars.`,
          metadata: { path: path.relative(workspaceRoot, target), kind: 'file-patch' },
        };
      }
      return {
        ok: false,
        summary: `patch_file: search string not found in ${path.relative(workspaceRoot, target)}`,
        output: `The search string was not found in the file. File has ${content.length} chars. First 500 chars of file:\n${content.slice(0, 500)}`,
        metadata: { path: path.relative(workspaceRoot, target), kind: 'file-patch' },
      };
    }
    // Reject ambiguous matches — if search string appears more than once,
    // the agent must provide a more specific (longer) search string to avoid
    // unintended edits elsewhere in the file.
    if (occurrences > 1) {
      return {
        ok: false,
        summary: `patch_file: ambiguous match — "${search.slice(0, 60)}..." appears ${occurrences} times in ${path.relative(workspaceRoot, target)}`,
        output: `The search string matches ${occurrences} locations in the file. Include more surrounding context in your search string so it matches exactly 1 location. Use read_file first to see the exact content around the target.`,
        metadata: { path: path.relative(workspaceRoot, target), kind: 'file-patch', occurrences },
      };
    }
    const patched = content.replace(search, replace);
    await fs.writeFile(target, patched, 'utf8');
    return {
      ok: true,
      summary: `Patched ${path.relative(workspaceRoot, target)} (1 occurrence)`,
      output: `Replaced 1 occurrence. File size: ${content.length} → ${patched.length} chars.`,
      rollback: `Restore previous content for ${path.relative(workspaceRoot, target)}.`,
      metadata: { path: path.relative(workspaceRoot, target), kind: 'file-patch' },
    };
  }

  // ---------------------------------------------------------------------------
  // search_files — grep across workspace files
  // ---------------------------------------------------------------------------
  if (tool === 'search_files') {
    const pattern = String(args.pattern || '');
    if (!pattern) {
      throw new Error('search_files requires a non-empty "pattern" string.');
    }
    const searchPath = args.path
      ? resolveWorkspacePath(workspaceRoot, String(args.path))
      : workspaceRoot;
    const maxResults = clampNumber(Number(args.max_results || 50), 1, 200, 50);
    const isRegex = args.is_regex === true;

    // Use grep for speed — available on all platforms
    const grepArgs = ['-rn', '--include=*.{js,ts,jsx,tsx,py,swift,json,html,css,md,txt,yaml,yml,toml,sh,rb,go,rs,java,c,cpp,h,hpp}'];
    if (isRegex) {
      grepArgs.push('-E', pattern);
    } else {
      grepArgs.push('-F', pattern);
    }
    grepArgs.push(searchPath);

    const grepResult = await runCommand({
      command: 'grep',
      args: grepArgs,
      cwd: workspaceRoot,
      timeoutMs: 30000,
      runId,
    });
    const lines = (grepResult.stdout || '').split('\n').filter(Boolean);
    const truncatedLines = lines.slice(0, maxResults);
    const relativized = truncatedLines.map((line) => {
      // Convert absolute paths to workspace-relative
      if (line.startsWith(workspaceRoot)) {
        return line.slice(workspaceRoot.length + 1);
      }
      return line;
    });

    return {
      ok: true,
      summary: `Found ${lines.length} match${lines.length === 1 ? '' : 'es'} for "${truncate(pattern, 40)}"${lines.length > maxResults ? ` (showing first ${maxResults})` : ''}`,
      output: relativized.length > 0
        ? relativized.join('\n')
        : `No matches found for "${pattern}" in ${path.relative(workspaceRoot, searchPath) || '.'}`,
      metadata: { kind: 'search', pattern, matchCount: lines.length },
    };
  }

  // ---------------------------------------------------------------------------
  // respond — send a direct reply to the user; useful for conversational and
  // general tasks that require no tool action beyond a well-formed response.
  // ---------------------------------------------------------------------------
  if (tool === 'respond') {
    const message = String(args.message || args.content || args.text || args.response || args.answer || '').trim();
    if (!message) {
      return { ok: false, tool, intent, summary: 'respond requires a message', output: 'No message provided.' };
    }
    return { ok: true, tool, intent, summary: truncate(message, 120), output: message };
  }

  // ---------------------------------------------------------------------------
  // think — reasoning/planning tool, no side effects. Lets the agent pause and
  // work through a problem before acting.
  // ---------------------------------------------------------------------------
  if (tool === 'think') {
    const thought = String(args.thought || args.reasoning || args.content || 'Reasoning about the problem...');
    return {
      ok: true,
      summary: 'Agent reasoning step',
      output: thought,
      metadata: { kind: 'think' },
    };
  }

  // ---------------------------------------------------------------------------
  // http_request — make HTTP requests for testing APIs, checking servers, etc.
  // ---------------------------------------------------------------------------
  if (tool === 'http_request') {
    const url = String(args.url || '');
    if (!url) {
      throw new Error('http_request requires a "url" argument.');
    }
    // Safety: only allow http/https
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('http_request only supports http:// and https:// URLs.');
    }
    const method = String(args.method || 'GET').toUpperCase();
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    if (!allowedMethods.has(method)) {
      throw new Error(`http_request method not allowed: ${method}`);
    }
    const headers = ensureObject(args.headers);
    const body = args.body !== undefined ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)) : undefined;
    const timeoutMs = clampNumber(Number(args.timeout_ms || 15000), 1000, 60000, 15000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOpts = { method, headers, signal: controller.signal };
      if (body && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = body;
        if (!headers['Content-Type'] && !headers['content-type']) {
          fetchOpts.headers = { ...headers, 'Content-Type': 'application/json' };
        }
      }
      const response = await fetch(url, fetchOpts);
      const responseText = await response.text();
      return {
        ok: response.ok,
        summary: `${method} ${url} → ${response.status} ${response.statusText}`,
        output: [
          `status: ${response.status} ${response.statusText}`,
          `headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2)}`,
          '',
          `body:\n${truncate(responseText, 4000)}`,
        ].join('\n'),
        metadata: { kind: 'http-request', method, url, status: response.status },
      };
    } catch (err) {
      const msg = err.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : String(err.message || err);
      return {
        ok: false,
        summary: `${method} ${url} → FAILED: ${truncate(msg, 100)}`,
        output: `Request failed: ${msg}`,
        metadata: { kind: 'http-request', method, url, error: true },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (tool === 'run_playwright') {
    const outcome = await runPlaywrightTool({
      ...args,
      owner,
    }, workspaceRoot, runId);
    return {
      ...outcome,
      metadata: {
        kind: 'playwright',
        url: String(args.url || ''),
      },
    };
  }

  if (tool === 'browser_launch') {
    const result = await launchBrowserAction(args);
    return {
      ...result,
      metadata: {
        ...(ensureObject(result.metadata)),
        kind: 'browser_launch',
        url: String(args.url || ''),
      },
    };
  }

  if (tool === 'browser_action') {
    const result = await performBrowserAction(args);
    return {
      ...result,
      metadata: {
        ...(ensureObject(result.metadata)),
        kind: 'browser_action',
        action: args.action,
      },
    };
  }

  if (tool === 'browser_close') {
    const result = await closeBrowserAction();
    return { ...result, metadata: { kind: 'browser_close' } };
  }

  if (tool === 'web_search') {
    return executeWebSearch({ ...args, braveApiKey: context?.braveSearchApiKey });
  }

  if (tool === 'web_scrape') {
    return executeWebScrape(args);
  }

  if (tool === 'web_fetch') {
    return executeWebFetch({ ...args, firecrawlApiKey: context?.firecrawlApiKey });
  }

  // Integration tools (GitHub, webhook, email, safe HTTP)
  const integrationTools = new Set([
    'github_list_issues', 'github_get_issue', 'github_create_issue',
    'github_create_pr', 'github_get_pr', 'github_pr_comments',
    'github_reply_review', 'github_ci_status', 'github_add_comment',
    'notify_webhook', 'send_email', 'http_get',
  ]);
  if (integrationTools.has(tool)) {
    const result = await executeIntegrationAction(tool, args);
    return {
      ok: true,
      summary: `Integration: ${tool}`,
      output: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      metadata: { kind: 'integration', tool },
    };
  }

  // delegate tool — requires LLM context, handled at agent-loop level.
  // If it reaches here, the caller didn't intercept it; return a no-op.
  if (tool === 'delegate') {
    return {
      ok: true,
      summary: `Delegate to ${args.role || 'specialist'}: ${truncate(args.task || '', 120)}`,
      output: '(delegate tool not available in this execution context — subagent results are injected by the agent loop)',
      metadata: { kind: 'delegate', role: args.role || 'specialist' },
    };
  }

  if (tool === 'safeguard_rejected') {
    return {
      ok: false,
      summary: 'Action Blocked: Objective out-of-bounds or hallucinated tools.',
      output: `Your previous proposed actions were rejected. ${args.reason || 'You are drifting from the main objective or hallucinating tools.'} Ensure you use the exact tools allowed and that your task specifically addresses the objective keywords: ${Array.isArray(args.anchors) ? args.anchors.join(', ') : 'unknown'}`,
      metadata: { kind: 'safeguard', tool },
    };
  }

  // Unknown tool — return an error result instead of throwing so the run continues.
  // The agent will see the error and can adjust on the next iteration.
  return {
    ok: false,
    summary: `Unknown tool: ${tool}`,
    output: `Tool "${tool}" is not recognized. Available tools: list_files, read_file, write_file, patch_file, append_file, search_files, run_command, think, delegate, http_request, run_playwright, analyze_image, web_search, web_scrape. To run external programs (vscode, xcode, compilers, etc.), use run_command with command="${tool}".`,
    metadata: { kind: 'unknown-tool', tool },
  };
}

// ---------------------------------------------------------------------------
// Security profile — human-friendly summary of what Geepus can/cannot do
// ---------------------------------------------------------------------------
function getSecurityProfile() {
  const tools = [
    { name: 'Browse Files', description: 'View folder contents and file structure', risk: 'low' },
    { name: 'Read Files', description: 'Open and read any project file', risk: 'low' },
    { name: 'Write Files', description: 'Create or overwrite project files', risk: 'medium' },
    { name: 'Patch Files', description: 'Surgical search-and-replace within files', risk: 'medium' },
    { name: 'Append to Files', description: 'Add content to the end of files', risk: 'medium' },
    { name: 'Search Files', description: 'Grep/search across workspace files', risk: 'low' },
    { name: 'Run Commands', description: 'Execute terminal commands (npm, git, python, etc.)', risk: 'medium' },
    { name: 'Run Browser Tests', description: 'Open pages in a browser and interact with them', risk: 'medium' },
    { name: 'Analyze Screenshots', description: 'Review an image and explain visible issues', risk: 'low' },
    { name: 'Web Search', description: 'Search the internet for information', risk: 'low' },
    { name: 'Read Webpages', description: 'Fetch and read content from a URL', risk: 'low' },
    { name: 'HTTP Request', description: 'Make HTTP requests to test APIs and services', risk: 'low' },
    { name: 'Think', description: 'Reason through a problem without side effects', risk: 'low' },
    { name: 'Delegate', description: 'Dispatch a specialist subagent for focused analysis', risk: 'low' },
  ];

  const blocked = [
    { command: 'sudo / su', reason: 'No administrator or root access — ever' },
    { command: 'launchctl', reason: 'Cannot install system services' },
    { command: 'osascript', reason: 'Cannot run AppleScript automation' },
    { command: 'security', reason: 'Cannot access Keychain or certificates' },
    { command: 'dd / diskutil', reason: 'Cannot modify disks or partitions' },
    { command: 'chown', reason: 'Cannot change file ownership' },
  ];

  const needsApproval = [
    { command: 'git push', reason: 'Publishing code to remote repositories' },
    { command: 'ssh / scp / rsync', reason: 'Connecting to remote servers' },
  ];

  const allowedCategories = [
    { category: 'Version Control', examples: 'git status, diff, log, commit, branch, merge', risk: 'low–medium' },
    { category: 'Package Managers', examples: 'npm, yarn, pnpm, pip, brew, cargo', risk: 'medium' },
    { category: 'Build & Test', examples: 'npm test, swift build, make, jest, pytest, playwright', risk: 'low' },
    { category: 'Scripting', examples: 'node, python3, ruby, bash scripts', risk: 'medium' },
    { category: 'File Management', examples: 'mkdir, cp, mv, rm, touch, chmod', risk: 'medium' },
    { category: 'Shell Utilities', examples: 'ls, pwd, cat, find, grep, sort, head, tail', risk: 'low' },
    { category: 'Data Processing', examples: 'jq, awk, sed, tr, cut, sort, uniq', risk: 'low' },
    { category: 'Containers', examples: 'docker, docker-compose, kubectl', risk: 'medium' },
    { category: 'Cloud CLIs', examples: 'aws, gcloud, vercel, netlify, firebase', risk: 'medium' },
    { category: 'Databases', examples: 'sqlite3, psql, mysql, redis-cli', risk: 'medium' },
    { category: 'Network', examples: 'curl, wget (sandboxed)', risk: 'medium' },
  ];

  return { tools, blocked, needsApproval, allowedCategories };
}

module.exports = {
  normalizeAction,
  normalizePlan,
  commandPolicy,
  withMinimumRisk,
  evaluateActionPolicy,
  getSecurityProfile,
  runCommand,
  sanitizeProfileName,
  pageHasSelector,
  isLikelyLoginPage,
  waitForManualLogin,
  runPlaywrightTool,
  executeWebSearch,
  executeWebScrape,
  executeAction,
};
