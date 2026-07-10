'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROVIDERS = {
  openai: {
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    defaultBaseUrl: 'https://api.anthropic.com/v1',
  },
  ollama: {
    defaultBaseUrl: 'http://localhost:11434/v1',
    noApiKey: true,
  },
};
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_BASE_URL = PROVIDERS[DEFAULT_PROVIDER].defaultBaseUrl;

function loadModelScores() {
  try {
    const prefsPath = path.join(os.homedir(), '.geepus', 'model-preferences.json');
    if (fs.existsSync(prefsPath)) {
      const data = fs.readFileSync(prefsPath, 'utf8');
      return JSON.parse(data);
    } else {
      // Create default
      const defaultScores = {
        "exact_match": {
          "o3-mini": 110,
          "gpt-4o": 105
        },
        "base_scores": {
          "opus": 130,
          "o4": 120,
          "sonnet": 115,
          "o3": 110,
          "o1": 100,
          "gpt-5": 95,
          "haiku": 95,
          "gpt-4.5": 90,
          "gpt-4o": 80,
          "codex": 75,
          "gpt-4": 70,
          "qwen3-coder": 55,
          "qwen3.6": 54,
          "qwen3": 50,
          "qwen2.5-coder": 48,
          "deepseek": 45,
          "qwen2.5": 42,
          "llama3": 40,
          "mistral": 35,
          "phi": 30,
          "gpt-3.5": 25,
          "gemma4": 52,
          "gemma3": 45,
          "gemma": 20
        },
        "modifiers": {
          ":30b": 10,
          ":32b": 10,
          ":34b": 10,
          ":14b": 5,
          ":13b": 5,
          "coder": 5,
          "code": 5,
          ":8b": 2,
          ":7b": 2,
          "preview": -5,
          ":2b": -5,
          ":1b": -5,
          ":0.5b": -5,
          "mini": -20
        }
      };
      fs.mkdirSync(path.join(os.homedir(), '.geepus'), { recursive: true });
      fs.writeFileSync(prefsPath, JSON.stringify(defaultScores, null, 2), 'utf8');
      return defaultScores;
    }
  } catch (err) {
    console.error('Failed to load model-preferences.json:', err);
    return {}; // fallback
  }
}

function getModelCapabilities(modelName) {
  const name = String(modelName || '').toLowerCase();
  
  const rules = {
    // Explicit known-weak vision models or non-vision
    isVision: /\b(vision|vl|llava|pixtral)\b/i.test(name) || (
      // Known multi-modal models that lack explicit 'vision' string
      /\b(gpt-4o|claude-3|gemini-1\.5|gemini-2\.0)\b/i.test(name) && !/\b(haiku|o1|o3)\b/i.test(name)
    ),
    isReasoning: /\b(o1|o3|r1|reason|think|deepseek-reasoner|claude-3-7)\b/i.test(name),
    isCoding: /\b(coder|code|qwq|qwen2\.5-coder)\b/i.test(name) || /\b(gpt-4o|claude-3-7|claude-3-5-sonnet|o1|o3|gemma3|gemma4)\b/i.test(name)
  };

  return rules;
}

function modelScore(modelName, prefs, requiredCapabilities = []) {
  const name = String(modelName || '').toLowerCase();
  let score = 0;
  
  if (!prefs) {
    prefs = loadModelScores();
  }

  // Filter out models that lack required capabilities
  const caps = getModelCapabilities(modelName);
  for (const req of requiredCapabilities) {
    if (!caps[req]) {
      return -9999; // Heavily penalize models that lack required capabilities
    }
  }

  if (prefs.exact_match && prefs.exact_match[name] !== undefined) {
    return prefs.exact_match[name];
  }

  if (prefs.base_scores) {
    // Sort keys by value descending to match the highest value base model first
    const sortedBases = Object.entries(prefs.base_scores).sort((a, b) => b[1] - a[1]);
    for (const [base, val] of sortedBases) {
      if (name.includes(base.toLowerCase())) {
        score += val;
        break; // Only apply the highest matching base score
      }
    }
  }

  if (prefs.modifiers) {
    for (const [mod, val] of Object.entries(prefs.modifiers)) {
      if (name.includes(mod.toLowerCase())) {
        score += val;
      }
    }
  }

  return score;
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : DEFAULT_PROVIDER;
}

function defaultBaseUrlForProvider(provider) {
  const resolved = normalizeProvider(provider);
  return PROVIDERS[resolved].defaultBaseUrl;
}

function pickBestModel(models, preferred, requiredCapabilities = []) {
  if (!Array.isArray(models) || models.length === 0) {
    return preferred || '';
  }

  // If the user explicitly chose a model and it exists (and passes capabilities if provided),
  // we could respect it. But for automated sub-tasks, we might want to override.
  const caps = getModelCapabilities(preferred);
  const preferredMeetsRequirements = requiredCapabilities.every((req) => caps[req]);

  if (preferred && models.includes(preferred) && preferredMeetsRequirements) {
    return preferred;
  }

  // Fuzzy match: Ollama model names can vary (qwen3-coder:30b vs qwen3-coder:latest)
  // Try progressively looser matching to honor the user's choice, ONLY if it meets capabilities
  if (preferred && preferredMeetsRequirements) {
    const prefLower = preferred.toLowerCase();
    const prefBase = prefLower.split(':')[0]; // e.g. "qwen3-coder"

    // 1. Exact case-insensitive match
    const exactCI = models.find((m) => m.toLowerCase() === prefLower);
    if (exactCI) return exactCI;

    // 2. Same base name (before the colon) — pick the best variant
    const sameBase = models.filter((m) => m.toLowerCase().split(':')[0] === prefBase);
    if (sameBase.length > 0) {
      // Prefer the exact tag if specified, otherwise pick the largest/best variant
      return sameBase.sort((a, b) => b.length - a.length)[0];
    }

    // 3. Starts-with match (user typed partial name)
    const startsWith = models.filter((m) => m.toLowerCase().startsWith(prefBase));
    if (startsWith.length > 0) {
      return startsWith.sort((a, b) => b.length - a.length)[0];
    }

    // 4. Contains match (e.g. user saved "qwen3" and model is "qwen3-coder:30b")
    const contains = models.filter((m) => m.toLowerCase().includes(prefBase));
    if (contains.length > 0) {
      return contains.sort((a, b) => b.length - a.length)[0];
    }
  }

  // No valid preferred model — pick the highest-scoring one.
  const prefs = loadModelScores();
  const sorted = [...models].sort((left, right) => modelScore(right, prefs, requiredCapabilities) - modelScore(left, prefs, requiredCapabilities));
  return sorted[0];
}

function normalizeModelList(rawModels, provider = DEFAULT_PROVIDER) {
  // Ollama: return all models — they are all usable chat models
  if (provider === 'ollama') {
    const unique = Array.from(new Set(rawModels.filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return unique;
  }
  const preferredPrefixes = provider === 'anthropic'
    ? ['claude-']
    : ['gpt-', 'o1', 'o3', 'o4', 'codex', 'chatgpt', 'whisper', 'tts-'];
  const excludedTerms = ['embedding', 'moderation', 'realtime'];

  const prefs = loadModelScores();
  const unique = Array.from(new Set(rawModels.filter(Boolean))).sort((a, b) => {
    const scoreDiff = modelScore(b, prefs) - modelScore(a, prefs);
    return scoreDiff !== 0 ? scoreDiff : a.localeCompare(b);
  });
  const preferred = unique.filter((model) => {
    const lower = model.toLowerCase();
    const isPreferred = preferredPrefixes.some((prefix) => lower.startsWith(prefix));
    const isExcluded = excludedTerms.some((term) => lower.includes(term));
    return isPreferred && !isExcluded;
  });

  return preferred.length > 0 ? preferred : unique;
}

function apiHeaders(provider, apiKey) {
  if (provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  if (provider === 'ollama') {
    return {
      'Content-Type': 'application/json',
    };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function parseError(response) {
  const text = await response.text();
  let message = text;

  try {
    const json = JSON.parse(text);
    if (json && json.error && json.error.message) {
      message = json.error.message;
    }
  } catch {
    // Keep original text
  }

  return `API request failed (${response.status}): ${message}`;
}

// Two-phase timeout for Ollama:
//   LOAD  — null = no timeout. Large models on consumer hardware can take many
//           minutes to cold-load; killing the request would abort the whole
//           objective. We rely on the chunk timeout to detect truly stuck gen.
//   CHUNK — once the first token arrives, this detects actually-hung generation.
//           Active generation emits a token at least every few seconds, so
//           5 minutes is extremely generous even for slow hardware.
const OLLAMA_LOAD_TIMEOUT_MS  = null;             // no timeout during load/prompt-eval
const OLLAMA_CHUNK_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes between streaming chunks
const OLLAMA_MAX_RESPONSE_MS  = 10 * 60 * 1000;  // 10-minute wall-clock cap on total response
const CLOUD_RESPONSE_TIMEOUT_MS = 90 * 1000;      // non-streaming cloud safety timeout
const OLLAMA_NUM_PREDICT      = 4096;            // max output tokens — prevents runaway generation
// Context window size for Ollama requests. Default Ollama context is only 2048
// which is far too small for the planner prompt. 8192 covers the prompt while
// keeping memory usage reasonable on consumer hardware.
const OLLAMA_NUM_CTX = 8192;

function systemRamGb() {
  return Math.max(1, Math.floor(os.totalmem() / (1024 * 1024 * 1024)));
}

function minimumRamGbForOllamaModel(model) {
  const m = String(model || '').toLowerCase();
  if (/qwen3\.6:35b-a3b|35b-a3b/.test(m)) return 32;
  if (/\b(30b|31b|32b|34b|35b|70b|72b)\b/.test(m)) return 32;
  if (/\b(22b|26b|27b)\b/.test(m)) return 24;
  if (/\b(14b|15b)\b/.test(m)) return 16;
  return 0;
}

function assertOllamaModelCompatible(model) {
  const minRamGb = minimumRamGbForOllamaModel(model);
  if (!minRamGb) return;
  const ramGb = systemRamGb();
  if (ramGb < minRamGb) {
    throw new Error(
      `Model \"${model}\" needs at least ${minRamGb} GB RAM (detected ${ramGb} GB). Choose a smaller model like qwen3:8b or qwen3:4b to avoid system instability.`,
    );
  }
}

/**
 * Pick the right num_ctx for a model. Larger models need less context to avoid
 * excessive memory/swap usage; smaller models can handle more.
 */
function ollamaNumCtx(model) {
  const m = (model || '').toLowerCase();
  // >30B models: keep context conservative to avoid memory spikes.
  if (/\b(30b|31b|32b|34b|35b|70b|72b)\b/.test(m) || /35b-a3b/.test(m)) return 4096;
  // 14-27B models: moderate context
  if (/\b(14b|15b|22b|26b|27b)\b/.test(m)) return 6144;
  // <=13B or unknown: use the default
  return OLLAMA_NUM_CTX;
}

function ollamaNumPredict(model) {
  const m = (model || '').toLowerCase();
  if (/\b(30b|31b|32b|34b|35b|70b|72b)\b/.test(m) || /35b-a3b/.test(m)) return 1024;
  if (/\b(14b|15b|22b|26b|27b)\b/.test(m)) return 2048;
  return OLLAMA_NUM_PREDICT;
}

/**
 * Retry helper for rate-limit (429), transient server (5xx), and connection errors.
 * Respects Retry-After header when present; otherwise uses exponential backoff.
 * Also retries on network-level errors (fetch failed / ECONNREFUSED) which happen
 * when Ollama is busy with another request or temporarily unreachable.
 */
async function fetchWithRetry(url, options, { maxRetries = 4, backoffCeilMs = 15000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (networkErr) {
      // AbortError = intentional timeout — never retry these
      if (networkErr.name === 'AbortError') {
        throw networkErr;
      }
      // Network-level failure (ECONNREFUSED, fetch failed, DNS, etc.)
      if (attempt >= maxRetries) {
        const hint = String(url).includes('localhost') || String(url).includes('127.0.0.1')
          ? ' Make sure Ollama is running (open the Ollama app or run `ollama serve`).'
          : '';
        throw new Error(
          `Connection failed after ${attempt + 1} attempts: ${networkErr.message || networkErr}.${hint}`,
        );
      }
      const waitMs = Math.min(1000 * Math.pow(2, attempt), backoffCeilMs) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (response.ok || (attempt >= maxRetries) ||
        (response.status !== 429 && response.status < 500)) {
      return response;
    }
    // Determine wait time: prefer Retry-After header, else exponential backoff
    const retryAfter = response.headers.get('retry-after');
    let waitMs;
    if (retryAfter) {
      const parsed = Number(retryAfter);
      waitMs = Number.isFinite(parsed) ? parsed * 1000 : 1000;
    } else {
      waitMs = Math.min(1000 * Math.pow(2, attempt), 30000);
    }
    // Add small jitter to avoid thundering herd
    waitMs += Math.random() * 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function extractOutputText(provider, payload) {
  // Ollama / Chat Completions format
  if (provider === 'ollama' && Array.isArray(payload.choices)) {
    const text = payload.choices
      .map((c) => c.message?.content || c.delta?.content || '')
      .join('')
      .trim();
    if (text.length > 0) return text;
  }

  if (provider === 'anthropic' && Array.isArray(payload.content)) {
    const parts = payload.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }

  if (typeof payload.output_text === 'string' && payload.output_text.trim().length > 0) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload.output)) {
    const parts = [];
    for (const item of payload.output) {
      if (!item || !Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (content && typeof content.text === 'string' && content.text.trim().length > 0) {
          parts.push(content.text.trim());
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }

  return 'No text response returned by the model.';
}

function toAnthropicMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    const messages = [];
    for (const entry of input) {
      if (!entry || entry.role === 'system') continue;
      
      const role = entry.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
      
      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += `\n\n${content}`;
      } else {
        messages.push({ role, content });
      }
    }
    
    if (messages.length > 0 && messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '(Continuing conversation)' });
    }
    
    return messages.length > 0 ? messages : [{ role: 'user', content: ' ' }];
  }
  return [{ role: 'user', content: String(input || '') }];
}

function extractSystemPrompt(input) {
  if (!Array.isArray(input)) {
    return '';
  }
  return input
    .filter((entry) => entry && entry.role === 'system' && typeof entry.content === 'string')
    .map((entry) => entry.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Convert the generic input (string or [{role, content}]) into OpenAI Chat Completions
 * messages format used by Ollama / LM Studio / etc.
 */
function toChatCompletionMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return input
      .filter((entry) => entry && typeof entry.content === 'string')
      .map((entry) => ({
        role: entry.role === 'system' || entry.role === 'assistant' ? entry.role : 'user',
        content: entry.content,
      }));
  }
  return [{ role: 'user', content: String(input || '') }];
}

function normalizeBaseUrl(baseUrl, provider = DEFAULT_PROVIDER) {
  const resolvedProvider = normalizeProvider(provider);
  const fallback = defaultBaseUrlForProvider(resolvedProvider);
  const raw = (baseUrl || fallback).trim();
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized) return fallback;

  // Self-heal stale config where provider and default base URL drift apart.
  // Keep custom endpoints (OpenRouter, Azure, etc.) intact.
  const knownProviders = ['openai', 'anthropic', 'ollama'];
  const isAnotherProviderDefault = knownProviders.some((candidate) => {
    if (candidate === resolvedProvider) return false;
    return normalized === defaultBaseUrlForProvider(candidate);
  });
  if (isAnotherProviderDefault) {
    return fallback;
  }

  return normalized;
}

async function listModels(provider, apiKey, baseUrl) {
  const url = `${normalizeBaseUrl(baseUrl, provider)}/models`;
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: apiHeaders(provider, apiKey),
  }, { maxRetries: 2 });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  const json = await response.json();
  // OpenAI-compatible: json.data; native Ollama /api/tags: json.models
  let ids;
  if (Array.isArray(json.data)) {
    ids = json.data.map((item) => item.id);
  } else if (Array.isArray(json.models)) {
    ids = json.models.map((item) => item.model || item.name);
  } else {
    ids = [];
  }
  return normalizeModelList(ids, provider);
}

async function callProviderResponse({
  provider,
  apiKey,
  baseUrl,
  model,
  input,
  temperature,
}) {
  const resolvedProvider = normalizeProvider(provider);
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl, resolvedProvider);

  let endpoint;
  let requestBody;
  const tempNum = Number(temperature);
  const sampling = Number.isFinite(tempNum) ? { temperature: tempNum } : {};

  if (resolvedProvider === 'anthropic') {
    endpoint = `${resolvedBaseUrl}/messages`;
    requestBody = {
      model,
      ...sampling,
      max_tokens: 16384,
      system: extractSystemPrompt(input) || undefined,
      messages: toAnthropicMessages(input),
    };
  } else if (resolvedProvider === 'ollama') {
    assertOllamaModelCompatible(model);
    endpoint = `${resolvedBaseUrl}/chat/completions`;
    const msgs = toChatCompletionMessages(input);
    // Qwen3 models: append /no_think to skip internal reasoning, saving time & tokens
    if (model && model.toLowerCase().includes('qwen3') && msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'user' && !last.content.includes('/no_think')) {
        last.content += ' /no_think';
      }
    }
    requestBody = {
      model,
      ...sampling,
      messages: msgs,
      options: { num_ctx: ollamaNumCtx(model), num_predict: ollamaNumPredict(model) },
    };
  } else {
    endpoint = `${resolvedBaseUrl}/responses`;
    requestBody = {
      model,
      input,
      ...sampling,
    };
  }

  const fetchOptions = {
    method: 'POST',
    headers: apiHeaders(resolvedProvider, apiKey),
    body: JSON.stringify(requestBody),
  };

  // Ollama is single-threaded — if it is busy generating, connections can stall.
  const retryOpts = resolvedProvider === 'ollama'
    ? { maxRetries: 4, backoffCeilMs: 15000 }
    : undefined;

  // Use the generous load timeout — the non-streaming path is only used when
  // callResponsesWithFallback forces streaming (which is always for Ollama),
  // so this is mainly a fallback safety net.
  let abortTimer;
  let abortCtrl;
  if (resolvedProvider === 'ollama') {
    abortCtrl = new AbortController();
    fetchOptions.signal = abortCtrl.signal;
    // OLLAMA_LOAD_TIMEOUT_MS is null — no timeout during model load/prompt-eval
    if (OLLAMA_LOAD_TIMEOUT_MS !== null) {
      abortTimer = setTimeout(() => abortCtrl.abort(), OLLAMA_LOAD_TIMEOUT_MS);
    }
  } else {
    abortCtrl = new AbortController();
    fetchOptions.signal = abortCtrl.signal;
    abortTimer = setTimeout(() => abortCtrl.abort(), CLOUD_RESPONSE_TIMEOUT_MS);
  }

  let response;
  try {
    response = await fetchWithRetry(endpoint, fetchOptions, retryOpts);
  } catch (err) {
    if (abortTimer) clearTimeout(abortTimer);
    if (err.name === 'AbortError') {
      if (resolvedProvider === 'ollama') {
        throw new Error('Ollama request timed out waiting for a response chunk. The model may be hung — try restarting Ollama.');
      }
      throw new Error(`${resolvedProvider} request timed out. The provider may be overloaded or temporarily unreachable.`);
    }
    throw err;
  }

  if (!response.ok) {
    if (abortTimer) clearTimeout(abortTimer);
    throw new Error(await parseError(response));
  }

  if (abortTimer) clearTimeout(abortTimer);
  return response.json();
}

/**
 * Streaming version of callProviderResponse. Calls onChunk(textDelta) for each
 * token and returns the full assembled payload for compatibility.
 */
async function callProviderResponseStreaming({
  provider,
  apiKey,
  baseUrl,
  model,
  input,
  temperature,
  onChunk,
}) {
  const resolvedProvider = normalizeProvider(provider);
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl, resolvedProvider);

  let endpoint;
  let body;
  const tempNum = Number(temperature);
  const sampling = Number.isFinite(tempNum) ? { temperature: tempNum } : {};

  if (resolvedProvider === 'anthropic') {
    endpoint = `${resolvedBaseUrl}/messages`;
    body = {
      model,
      ...sampling,
      max_tokens: 16384,
      stream: true,
      system: extractSystemPrompt(input) || undefined,
      messages: toAnthropicMessages(input),
    };
  } else if (resolvedProvider === 'ollama') {
    assertOllamaModelCompatible(model);
    endpoint = `${resolvedBaseUrl}/chat/completions`;
    const msgs = toChatCompletionMessages(input);
    // Qwen3 models: append /no_think to skip internal reasoning, saving time & tokens
    if (model && model.toLowerCase().includes('qwen3') && msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === 'user' && !last.content.includes('/no_think')) {
        last.content += ' /no_think';
      }
    }
    body = {
      model,
      ...sampling,
      stream: true,
      messages: msgs,
      options: { num_ctx: ollamaNumCtx(model), num_predict: ollamaNumPredict(model) },
    };
  } else {
    endpoint = `${resolvedBaseUrl}/responses`;
    body = {
      model,
      input,
      ...sampling,
      stream: true,
    };
  }

  // Two-phase Ollama timeout:
  //   Phase 1 (LOAD)  — covers model loading + prompt ingestion. Generous
  //                      because cold-loading a 14B model can take minutes.
  //   Phase 2 (CHUNK) — once the first chunk arrives, switch to a tighter
  //                      timer that detects genuinely hung generation.
  const fetchOpts = {
    method: 'POST',
    headers: apiHeaders(resolvedProvider, apiKey),
    body: JSON.stringify(body),
  };
  // Universal stream abort controller — works for ALL providers.
  // Ollama uses fine-grained load/chunk/wall timers; cloud providers
  // (Anthropic, OpenAI) get a simpler chunk-idle + wall-clock cap.
  const CLOUD_CHUNK_IDLE_MS = 3 * 60 * 1000;   // 3 min with no chunk = dead
  const CLOUD_WALL_MS       = 10 * 60 * 1000;   // 10 min total max

  const abortCtrl = new AbortController();
  fetchOpts.signal = abortCtrl.signal;

  let chunkTimer;
  let wallTimer;
  let chunksReceived = 0;
  const isOllama = resolvedProvider === 'ollama';

  const resetChunkTimer = () => {
    clearTimeout(chunkTimer);
    if (isOllama) {
      // Ollama: no timeout during load/prompt-eval (OLLAMA_LOAD_TIMEOUT_MS is null).
      // Once chunks arrive, apply the chunk idle timeout.
      const ms = chunksReceived > 0 ? OLLAMA_CHUNK_TIMEOUT_MS : OLLAMA_LOAD_TIMEOUT_MS;
      if (ms !== null) {
        chunkTimer = setTimeout(() => abortCtrl.abort(), ms);
      }
      // Start Ollama wall-clock cap on first chunk
      if (chunksReceived === 1 && OLLAMA_MAX_RESPONSE_MS !== null) {
        wallTimer = setTimeout(() => abortCtrl.abort(), OLLAMA_MAX_RESPONSE_MS);
      }
    } else {
      // Cloud providers: simple chunk-idle timeout
      chunkTimer = setTimeout(() => abortCtrl.abort(), CLOUD_CHUNK_IDLE_MS);
    }
  };

  // Cloud providers: start a wall-clock cap immediately
  if (!isOllama) {
    wallTimer = setTimeout(() => abortCtrl.abort(), CLOUD_WALL_MS);
  }

  const streamRetryOpts = isOllama
    ? { maxRetries: 4, backoffCeilMs: 15000 }
    : undefined;

  let response;
  try {
    response = await fetchWithRetry(endpoint, fetchOpts, streamRetryOpts);
  } catch (err) {
    clearTimeout(chunkTimer);
    clearTimeout(wallTimer);
    if (err.name === 'AbortError') {
      const providerLabel = isOllama ? 'Ollama' : resolvedProvider;
      throw new Error(`${providerLabel} streaming request timed out. The provider may be overloaded or the network connection stalled.`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(chunkTimer);
    clearTimeout(wallTimer);
    throw new Error(await parseError(response));
  }

  // Connection established — start chunk-idle timer while waiting for first token
  resetChunkTimer();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collectedText = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      clearTimeout(chunkTimer);
      clearTimeout(wallTimer);
      break;
    }
    // Track chunks so resetChunkTimer switches from load→chunk timeout
    chunksReceived++;
    // Reset the idle timeout on every chunk — the model is actively generating
    resetChunkTimer();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        let delta = '';

        if (resolvedProvider === 'anthropic') {
          if (event.type === 'content_block_delta' && event.delta && event.delta.text) {
            delta = event.delta.text;
          }
        } else if (resolvedProvider === 'ollama') {
          // Chat Completions streaming: choices[0].delta.content
          if (Array.isArray(event.choices) && event.choices[0]?.delta?.content) {
            delta = event.choices[0].delta.content;
          }
        } else {
          // OpenAI responses API streaming
          if (event.type === 'response.output_text.delta' && event.delta) {
            delta = event.delta;
          }
        }

        if (delta) {
          collectedText.push(delta);
          if (typeof onChunk === 'function') {
            onChunk(delta);
          }
        }
      } catch {
        // Skip malformed SSE events
      }
    }
  }

  const fullText = collectedText.join('');
  // Return a synthetic payload matching the non-streaming shape
  if (resolvedProvider === 'anthropic') {
    return { content: [{ type: 'text', text: fullText }] };
  }
  if (resolvedProvider === 'ollama') {
    return { choices: [{ message: { content: fullText } }] };
  }
  return { output_text: fullText };
}

function isModelAccessError(error) {
  const message = String(error?.message || error).toLowerCase();
  return (
    message.includes('does not have access to model') ||
    message.includes('model_not_found') ||
    message.includes('no model named') ||
    message.includes('permission denied for model') ||
    message.includes('not_found_error')
  );
}

function extractUnsupportedParameters(error) {
  const message = String(error?.message || error || '');
  const found = new Set();

  // Examples:
  // "Unsupported parameter: 'temperature' is not supported with this model."
  // "Unknown parameter: temperature"
  const singleQuoted = /(?:unsupported|unknown)\s+parameter:\s*'([^']+)'/gi;
  let match = singleQuoted.exec(message);
  while (match) {
    found.add(String(match[1] || '').trim().toLowerCase());
    match = singleQuoted.exec(message);
  }

  const bareName = /(?:unsupported|unknown)\s+parameter:\s*([a-zA-Z0-9_.-]+)/gi;
  match = bareName.exec(message);
  while (match) {
    found.add(String(match[1] || '').trim().toLowerCase());
    match = bareName.exec(message);
  }

  if (found.size === 0 && /not supported with this model/i.test(message) && /temperature/i.test(message)) {
    found.add('temperature');
  }

  return Array.from(found);
}

// Returns true when an Ollama model timed out (chunk idle timeout only —
// load timeout is disabled so this only fires if generation goes fully silent).
function isOllamaTimeoutError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes('ollama request timed out');
}

// Heuristic size rank for Ollama model names — lower = smaller/faster.
function ollamaModelSizeRank(name) {
  const m = (name || '').toLowerCase();
  if (/\b(0\.5b|1b|1\.5b|e2b)\b/.test(m)) return 1;
  if (/\b(2b|3b|e4b)\b/.test(m))          return 2;
  if (/\b(7b|8b)\b/.test(m))              return 3;
  if (/\b(13b|14b)\b/.test(m))            return 5;
  if (/\b(22b|26b|27b|30b|31b|32b)\b/.test(m)) return 7;
  if (/\b(34b|70b|72b)\b/.test(m))        return 9;
  return 4; // unknown size — treat as medium
}

// Note: writeSettings is passed in lazily to avoid circular dependency with settings.js
let _writeSettings = null;
function setWriteSettings(fn) {
  _writeSettings = fn;
}

async function callResponsesWithFallback({ settings, model, input, temperature, callGuards = null, onChunk = null }) {
  const resolvedProvider = normalizeProvider(settings.provider);

  // Always use streaming for Ollama — the streaming path resets the abort
  // timer on every chunk so active generation never times out, even if the
  // model takes 10+ minutes for a complex response.  Without this, the fixed
  // non-streaming timeout kills legitimate long-running completions.
  const forceStream = resolvedProvider === 'ollama';
  const useStreaming = forceStream || typeof onChunk === 'function';
  const callFn = useStreaming ? callProviderResponseStreaming : callProviderResponse;

  const invokeModel = async (targetModel, targetTemperature) => {
    if (callGuards && typeof callGuards.beforeModelCall === 'function') {
      await callGuards.beforeModelCall();
    }
    const callArgs = {
      provider: settings.provider,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: targetModel,
      input,
      temperature: targetTemperature,
    };
    if (useStreaming) callArgs.onChunk = onChunk || (() => {});

    const payload = await callFn(callArgs);
    if (callGuards && typeof callGuards.afterModelCall === 'function') {
      callGuards.afterModelCall({ payload, model: targetModel });
    }
    return payload;
  };

  const invokeModelWithSelfHeal = async (targetModel, targetTemperature) => {
    try {
      return await invokeModel(targetModel, targetTemperature);
    } catch (error) {
      // Self-heal for OpenAI-compatible models that reject sampling params.
      if (resolvedProvider === 'openai') {
        const unsupported = extractUnsupportedParameters(error);
        if (
          unsupported.includes('temperature')
          && Number.isFinite(Number(targetTemperature))
        ) {
          console.log(`[param-self-heal] "${targetModel}" rejected temperature; retrying without temperature`);
          return invokeModel(targetModel, undefined);
        }
      }
      throw error;
    }
  };

  try {
    const payload = await invokeModelWithSelfHeal(model, temperature);
    return { payload, model, switchedModel: false };
  } catch (error) {
    const isTimeout = isOllamaTimeoutError(error);
    if (!isModelAccessError(error) && !isTimeout) {
      throw error;
    }

    const models = await listModels(settings.provider, settings.apiKey, settings.baseUrl);
    let fallback;
    if (isTimeout) {
      // On timeout: prefer a smaller/faster model so we don't hang again
      const candidates = models
        .filter((c) => c !== model)
        .sort((a, b) => ollamaModelSizeRank(a) - ollamaModelSizeRank(b));
      fallback = candidates[0] || models[0];
    } else {
      // On access error: prefer a similar model (same family) first
      const modelBase = model ? model.toLowerCase().split(':')[0].split('-')[0] : '';
      const similarFallback = modelBase
        ? models.find((c) => c !== model && c.toLowerCase().includes(modelBase))
        : null;
      fallback = similarFallback
        || models.find((candidate) => candidate !== model)
        || models[0];
    }

    if (!fallback || fallback === model) {
      if (isTimeout) {
        throw new Error(
          `Ollama model "${model}" timed out and no other models are available to fall back to. ` +
          `Install a smaller model (e.g. qwen2.5:3b, gemma3:4b) in Ollama and retry.`
        );
      }
      throw error;
    }
    if (isTimeout) {
      console.log(`[model-fallback] "${model}" timed out, falling back to smaller model "${fallback}"`);
    } else {
      console.log(`[model-fallback] "${model}" not accessible, falling back to "${fallback}"`);
    }

    const payload = await invokeModelWithSelfHeal(fallback, temperature);

    if (_writeSettings) {
      await _writeSettings({ ...settings, model: fallback });
    }
    return { payload, model: fallback, switchedModel: true };
  }
}

async function resolveAgentModel(settings, requestedModel, objective = '', requiredCapabilities = []) {
  const discoveredModels = await listModels(settings.provider, settings.apiKey, settings.baseUrl);
  if (discoveredModels.length === 0) {
    throw new Error('No models available for this key.');
  }

  let preferred = typeof requestedModel === 'string' && requestedModel.trim().length > 0
    ? requestedModel.trim()
    : settings.model;

  if (preferred === 'auto') {
    const isCoding = /\b(code|build|script|app|react|python|js|ts|html|css)\b/i.test(objective);
    const isComplex = objective.length > 100 || /\b(architect|design|refactor|analyze)\b/i.test(objective);
    
    // Dynamically request capabilities instead of hard-coding models by provider
    const dynamicReqs = [...requiredCapabilities];
    if (isComplex && !dynamicReqs.includes('isReasoning')) {
      dynamicReqs.push('isReasoning');
    }
    if (isCoding && !dynamicReqs.includes('isCoding')) {
      dynamicReqs.push('isCoding');
    }
    
    // Overwrite the required capabilities with our new dynamically discovered ones
    requiredCapabilities = dynamicReqs;
    
    // Clear out 'auto' string so pickBestModel relies purely on the capability scores
    preferred = '';
  }

  const picked = pickBestModel(discoveredModels, preferred, requiredCapabilities);
  return {
    model: picked,
    models: discoveredModels,
  };
}

function providerRequiresApiKey(provider) {
  const resolved = normalizeProvider(provider);
  return !PROVIDERS[resolved]?.noApiKey;
}

/**
 * Given settings (which now stores apiKeys per-provider), return the active
 * provider and its API key. When provider is 'auto', picks the best available
 * provider based on which keys are set.
 */
function resolveProviderAndKey(settings) {
  const rawProvider = String(settings.provider || '').trim().toLowerCase();
  const keys = settings.apiKeys || {};
  const legacyKey = typeof settings.apiKey === 'string' ? settings.apiKey : '';

  if (rawProvider === 'ollama') {
    return { provider: 'ollama', apiKey: '', baseUrl: settings.baseUrl };
  }

  if (rawProvider === 'auto') {
    // Priority: anthropic (latest Claude) > openai > ollama fallback
    if (keys.anthropic) return { provider: 'anthropic', apiKey: keys.anthropic, baseUrl: defaultBaseUrlForProvider('anthropic') };
    if (keys.openai || legacyKey) return { provider: 'openai', apiKey: keys.openai || legacyKey, baseUrl: defaultBaseUrlForProvider('openai') };
    return { provider: 'ollama', apiKey: '', baseUrl: defaultBaseUrlForProvider('ollama') };
  }

  const provider = normalizeProvider(rawProvider);
  const apiKey = keys[provider] || legacyKey || '';
  const baseUrl = settings.baseUrl || defaultBaseUrlForProvider(provider);
  return { provider, apiKey, baseUrl };
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  DEFAULT_BASE_URL,
  modelScore,
  normalizeProvider,
  normalizeBaseUrl,
  defaultBaseUrlForProvider,
  pickBestModel,
  normalizeModelList,
  apiHeaders,
  parseError,
  extractOutputText,
  toAnthropicMessages,
  toChatCompletionMessages,
  extractSystemPrompt,
  listModels,
  callProviderResponse,
  callProviderResponseStreaming,
  isModelAccessError,
  extractUnsupportedParameters,
  callResponsesWithFallback,
  resolveAgentModel,
  setWriteSettings,
  providerRequiresApiKey,
  resolveProviderAndKey,
};
