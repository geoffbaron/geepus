'use strict';

const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * ollama-manager.js — Handles Ollama lifecycle for non-technical users:
 *   - Detect whether Ollama is installed
 *   - Auto-start `ollama serve` if not running
 *   - Curated catalog of recommended local models
 *   - Pull (download) models with streaming progress
 *   - Delete downloaded models
 *   - List locally-available models
 */

// ---------------------------------------------------------------------------
// Curated model catalog — friendly descriptions for non-technical users
// ---------------------------------------------------------------------------

const MODEL_CATALOG = [
  {
    id: 'llama3.2:3b',
    name: 'Llama 3.2',
    size: '3B',
    downloadSize: '~2 GB',
    description: 'Fast and capable — great everyday assistant. Best balance of speed and smarts.',
    tags: ['recommended', 'fast'],
  },
  {
    id: 'llama3.2:1b',
    name: 'Llama 3.2 Tiny',
    size: '1B',
    downloadSize: '~1.3 GB',
    description: 'Ultra-fast and very small. Good for quick questions on older Macs.',
    tags: ['lightweight'],
  },
  {
    id: 'mistral:7b',
    name: 'Mistral',
    size: '7B',
    downloadSize: '~4.1 GB',
    description: 'Strong all-around model. Great for writing, analysis, and coding.',
    tags: ['popular'],
  },
  {
    id: 'qwen2.5:7b',
    name: 'Qwen 2.5',
    size: '7B',
    downloadSize: '~4.7 GB',
    description: 'Excellent for coding and reasoning tasks. Strong multilingual support.',
    tags: ['coding'],
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder',
    size: '7B',
    downloadSize: '~4.7 GB',
    description: 'Purpose-built for code generation, debugging, and refactoring. Top-tier coding model.',
    tags: ['coding', 'recommended'],
  },
  {
    id: 'gemma2:2b',
    name: 'Gemma 2',
    size: '2B',
    downloadSize: '~1.6 GB',
    description: 'Google\'s compact model. Fast with good quality for its size.',
    tags: ['fast'],
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 (4B)',
    size: '4B',
    downloadSize: '~3.3 GB',
    description: 'Google\'s Gemma 3 — fast and capable. Great everyday assistant with improved instruction following.',
    tags: ['recommended', 'fast'],
  },
  {
    id: 'gemma3:12b',
    name: 'Gemma 3 (12B)',
    size: '12B',
    downloadSize: '~8 GB',
    description: 'Google\'s Gemma 3 mid-size — strong reasoning and coding. Best for Macs with 16 GB+ RAM.',
    minRamGb: 16,
    tags: ['quality', 'coding'],
  },
  {
    id: 'gemma3:27b',
    name: 'Gemma 3 (27B)',
    size: '27B',
    downloadSize: '~17 GB',
    description: 'Google\'s largest Gemma 3 — near top-tier quality for reasoning and long-context tasks. Needs 32 GB+ RAM.',
    minRamGb: 32,
    tags: ['quality', 'reasoning'],
  },
  {
    id: 'gemma4:e2b',
    name: 'Gemma 4 (2B)',
    size: '2B',
    downloadSize: '~1.8 GB',
    description: 'Google\'s Gemma 4 smallest — fast and capable on any Mac. Great for quick tasks.',
    tags: ['fast'],
  },
  {
    id: 'gemma4:e4b',
    name: 'Gemma 4 (4B)',
    size: '4B',
    downloadSize: '~3.3 GB',
    description: 'Google\'s Gemma 4 compact — improved multimodal reasoning over Gemma 3. Best everyday local model.',
    tags: ['recommended', 'fast'],
  },
  {
    id: 'gemma4:26b',
    name: 'Gemma 4 (26B MoE)',
    size: '26B MoE',
    downloadSize: '~17 GB',
    description: 'Google\'s Gemma 4 large — Mixture-of-Experts with 4B active per token. Near frontier quality at lower compute. Needs 24 GB+ RAM.',
    minRamGb: 24,
    tags: ['quality', 'reasoning', 'recommended'],
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 (31B)',
    size: '31B',
    downloadSize: '~20 GB',
    description: 'Google\'s Gemma 4 flagship — top-tier quality for complex reasoning, coding, and long-context tasks. Needs 32 GB+ RAM.',
    minRamGb: 32,
    tags: ['quality', 'reasoning'],
  },
  {
    id: 'phi4-mini',
    name: 'Phi-4 Mini',
    size: '3.8B',
    downloadSize: '~2.5 GB',
    description: 'Microsoft\'s efficient model. Punches well above its weight for reasoning.',
    tags: ['reasoning'],
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1',
    size: '8B',
    downloadSize: '~4.7 GB',
    description: 'Larger and smarter. Best quality for Macs with 16 GB+ RAM.',
    minRamGb: 16,
    tags: ['quality'],
  },
  {
    id: 'deepseek-r1:8b',
    name: 'DeepSeek R1',
    size: '8B',
    downloadSize: '~4.9 GB',
    description: 'Optimized for step-by-step reasoning and complex problem solving.',
    minRamGb: 16,
    tags: ['reasoning'],
  },
  {
    id: 'qwen3.6:35b-a3b',
    name: 'Qwen 3.6 (35B-A3B)',
    size: '35B MoE',
    downloadSize: '~22 GB',
    description: 'Qwen 3.6 Mixture-of-Experts — only 3B parameters active per token. Near top-tier quality at a fraction of the compute. Best for agentic and coding tasks on Macs with 32 GB+ RAM.',
    minRamGb: 32,
    tags: ['recommended', 'coding', 'reasoning', 'quality'],
  },
  {
    id: 'qwen3:4b',
    name: 'Qwen 3 (4B)',
    size: '4B',
    downloadSize: '~2.6 GB',
    description: 'Compact Qwen 3 — fast, capable reasoning and coding on any Mac.',
    tags: ['recommended', 'fast', 'coding'],
  },
  {
    id: 'qwen3:8b',
    name: 'Qwen 3 (8B)',
    size: '8B',
    downloadSize: '~5.2 GB',
    description: 'Best balance of quality and speed in the Qwen 3 line. Top-tier coding, reasoning, and tool use.',
    tags: ['coding', 'reasoning', 'recommended'],
  },
  {
    id: 'qwen3:14b',
    name: 'Qwen 3 (14B)',
    size: '14B',
    downloadSize: '~9 GB',
    description: 'High-quality Qwen 3 for complex tasks. Needs 16 GB+ RAM. Excellent at agentic work.',
    minRamGb: 16,
    tags: ['coding', 'reasoning', 'quality'],
  },
  {
    id: 'qwen3-coder:30b',
    name: 'Qwen 3 Coder',
    size: '30B',
    downloadSize: '~18 GB',
    description: 'Purpose-built for code generation and agentic tasks. Needs 32 GB+ RAM.',
    minRamGb: 32,
    tags: ['coding', 'recommended', 'quality'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '?';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `~${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `~${Math.round(mb)} MB`;
}

// ---------------------------------------------------------------------------
// Ollama paths — common install locations on macOS
// ---------------------------------------------------------------------------

const OLLAMA_PATHS = [
  '/usr/local/bin/ollama',
  '/opt/homebrew/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
  path.join(os.homedir(), 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
  path.join(os.homedir(), '.ollama', 'bin', 'ollama'),
  'ollama', // fall back to PATH
];

// Ollama default API endpoint
const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';

// ---------------------------------------------------------------------------
// Detect & Health
// ---------------------------------------------------------------------------

/**
 * Find the `ollama` binary on this machine.
 * Returns the path string or null.
 */
function findOllamaBinary() {
  return new Promise((resolve) => {
    // Try `which ollama` first — covers PATH additions and Homebrew
    exec('which ollama', (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      // Fall back to known paths
      const { existsSync } = require('fs');
      for (const p of OLLAMA_PATHS) {
        if (p !== 'ollama' && existsSync(p)) {
          resolve(p);
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * Check if the Ollama API server is reachable.
 */
async function isOllamaRunning() {
  try {
    const resp = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Full health check: is installed? is running? what models are local?
 */
async function ollamaStatus() {
  const binaryPath = await findOllamaBinary();
  const running = await isOllamaRunning();
  const systemRamGb = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
  // If the server is responding, Ollama is definitely installed — even if we
  // couldn't find the CLI binary (e.g. macOS app bundle running as a service).
  const installed = Boolean(binaryPath) || running;
  // Also check for the .app bundle on macOS as a last resort
  const appExists = !installed && require('fs').existsSync('/Applications/Ollama.app');
  const finalInstalled = installed || appExists;
  let localModels = [];

  if (running) {
    try {
      localModels = await listLocalModels();
    } catch {
      // ignore
    }
  }

  // Enrich catalog with download status
  const catalog = MODEL_CATALOG.map((entry) => ({
    ...entry,
    compatible: !(entry.minRamGb && systemRamGb < entry.minRamGb),
    incompatible: Boolean(entry.minRamGb && systemRamGb < entry.minRamGb),
    compatibilityNote: entry.minRamGb && systemRamGb < entry.minRamGb
      ? `Requires at least ${entry.minRamGb} GB RAM (detected ${systemRamGb.toFixed(1)} GB).`
      : '',
    downloaded: localModels.some((m) => modelsMatch(m, entry.id)),
  }));

  // Add any locally-installed models that aren't in the catalog,
  // so manually-pulled models still appear in the UI.
  for (const lm of localModels) {
    const localName = (lm.name || lm).toString().toLowerCase().replace(/:latest$/, '');
    const alreadyInCatalog = MODEL_CATALOG.some((entry) => modelsMatch(localName, entry.id));
    if (!alreadyInCatalog) {
      catalog.push({
        id: lm.name || lm,
        name: (lm.name || lm).toString().replace(/:latest$/, ''),
        size: lm.size ? formatBytes(lm.size) : '?',
        downloadSize: lm.size ? formatBytes(lm.size) : '?',
        description: 'Locally installed model (not in curated catalog).',
        tags: ['local'],
        compatible: true,
        incompatible: false,
        compatibilityNote: '',
        downloaded: true,
      });
    }
  }

  return {
    installed: finalInstalled,
    running,
    binaryPath,
    systemRamGb,
    localModels,
    catalog,
    installUrl: 'https://ollama.com/download',
  };
}

/**
 * Loose model-name matching.  Ollama's local model list can include
 * variant suffixes (e.g. "llama3.2:3b-instruct-q4_0") that should still
 * match our catalog entry "llama3.2:3b".
 */
function modelsMatch(localName, catalogId) {
  const raw = typeof localName === 'object' ? (localName.name || localName.model || '') : String(localName);
  const a = raw.toLowerCase().replace(/:latest$/, '');
  const b = catalogId.toLowerCase().replace(/:latest$/, '');
  return a === b || a.startsWith(b);
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

let _serveProcess = null;

/**
 * Start `ollama serve` if it isn't already running.
 * Returns true if it started (or was already running).
 */
async function ensureOllamaRunning() {
  if (await isOllamaRunning()) return true;

  const binaryPath = await findOllamaBinary();

  // If we have the CLI binary, use `ollama serve` directly
  if (binaryPath) {
    return new Promise((resolve) => {
      _serveProcess = spawn(binaryPath, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      _serveProcess.unref();

      let attempts = 0;
      const check = setInterval(async () => {
        attempts++;
        if (await isOllamaRunning()) {
          clearInterval(check);
          resolve(true);
        } else if (attempts >= 15) {
          clearInterval(check);
          resolve(false);
        }
      }, 500);
    });
  }

  // Fallback: try launching the macOS Ollama.app
  if (require('fs').existsSync('/Applications/Ollama.app')) {
    return new Promise((resolve) => {
      exec('open -a Ollama', (err) => {
        if (err) { resolve(false); return; }
        let attempts = 0;
        const check = setInterval(async () => {
          attempts++;
          if (await isOllamaRunning()) {
            clearInterval(check);
            resolve(true);
          } else if (attempts >= 20) {
            clearInterval(check);
            resolve(false);
          }
        }, 500);
      });
    });
  }

  return false;
}

/**
 * Clean shutdown on app quit.
 */
function stopOllamaServe() {
  if (_serveProcess && !_serveProcess.killed) {
    try {
      _serveProcess.kill();
    } catch {
      // already gone
    }
    _serveProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

async function listLocalModels() {
  const resp = await fetch(`${OLLAMA_ORIGIN}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error('Could not list Ollama models');
  const json = await resp.json();
  return (json.models || []).map((m) => ({
    name: m.name || m.model,
    size: m.size,
    modifiedAt: m.modified_at,
    digest: m.digest,
  }));
}

// ---------------------------------------------------------------------------
// Pull (download) a model — streams progress
// ---------------------------------------------------------------------------

/**
 * Pull a model from Ollama's registry.
 * @param {string} modelId   e.g. "llama3.2:3b"
 * @param {function} onProgress  Called with { status, total, completed, percent }
 * @returns {{ success: boolean, error?: string }}
 */
async function pullModel(modelId, onProgress) {
  const resp = await fetch(`${OLLAMA_ORIGIN}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: true }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to start download: ${text}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Ollama streams newline-delimited JSON
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const progress = {
          status: event.status || '',
          total: event.total || 0,
          completed: event.completed || 0,
          percent: 0,
        };
        if (progress.total > 0) {
          progress.percent = Math.round((progress.completed / progress.total) * 100);
        }
        if (typeof onProgress === 'function') {
          onProgress(progress);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Delete a model
// ---------------------------------------------------------------------------

async function deleteModel(modelId) {
  const resp = await fetch(`${OLLAMA_ORIGIN}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to delete model: ${text}`);
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MODEL_CATALOG,
  OLLAMA_ORIGIN,
  findOllamaBinary,
  isOllamaRunning,
  ollamaStatus,
  ensureOllamaRunning,
  stopOllamaServe,
  listLocalModels,
  pullModel,
  deleteModel,
};
