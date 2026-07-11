import type { ChatChunk, ChatRequest, OllamaPullProgress, ProviderId, ToolCall } from '@shared/model';
import type { ModelProvider } from './provider';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
/** Generous for slow local inference, but bounded — see the comment at the fetch call site. */
const CHAT_TIMEOUT_MS = 120_000;

export interface OllamaConfig {
  baseUrl?: string;
  model: string;
}

export async function isOllamaServerUp(baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const OLLAMA_BINARY_PATHS = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];

export async function findOllamaBinary(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('which', ['ollama']);
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // not on PATH — fall through to hardcoded install locations
  }
  const { access } = await import('node:fs/promises');
  for (const path of OLLAMA_BINARY_PATHS) {
    try {
      await access(path);
      return path;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function listOllamaModels(baseUrl = DEFAULT_BASE_URL): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags failed: ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  return (data.models ?? []).map((m) => m.name);
}

export interface OllamaModelInfo {
  name: string;
  sizeGb: number;
  chatCapable: boolean;
}

/**
 * Ollama's own capability list for a model (e.g. ["completion","tools"] vs ["embedding"]) —
 * the authoritative signal for "can this model actually chat", found live: setup's Path A
 * "adopt an already-installed model" heuristic used to judge fit by size alone, which meant
 * an installed embedding-only model (e.g. nomic-embed-text, ~0.3GB) could get recommended as
 * the chat driver since it's small enough to "fit" any machine.
 */
export async function isOllamaModelChatCapable(name: string, baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return true; // metadata hiccup — don't block adoption on it, size-fit still applies
    const data = (await res.json()) as { capabilities?: string[] };
    if (!Array.isArray(data.capabilities) || data.capabilities.length === 0) return true;
    return data.capabilities.includes('completion');
  } catch {
    return true; // network hiccup — fail open
  }
}

/** Like listOllamaModels but with byte sizes, so setup/discovery.ts can judge "does this fit RAM". */
export async function listOllamaModelsDetailed(baseUrl = DEFAULT_BASE_URL): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags failed: ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
  return Promise.all(
    (data.models ?? []).map(async (m) => ({
      name: m.name,
      sizeGb: Math.round(((m.size ?? 0) / 1024 ** 3) * 10) / 10,
      chatCapable: await isOllamaModelChatCapable(m.name, baseUrl),
    })),
  );
}

/** Spawns `ollama serve` detached and polls until the HTTP API responds. */
export async function startOllamaServe(binaryPath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const child = spawn(binaryPath, ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isOllamaServerUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('ollama serve did not become ready within 15s');
}

/** Streams NDJSON pull progress, byte counts included, so the wizard can show a real progress bar. */
export async function* pullOllamaModel(
  tag: string,
  baseUrl = DEFAULT_BASE_URL,
): AsyncGenerator<OllamaPullProgress> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    body: JSON.stringify({ name: tag, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama pull failed: ${res.status}`);

  for await (const parsed of readNdjson<{ status: string; completed?: number; total?: number }>(res.body)) {
    yield {
      model: tag,
      status: parsed.status,
      completedBytes: parsed.completed,
      totalBytes: parsed.total,
      done: parsed.status === 'success',
    };
  }
}

async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
}

interface OllamaResponseMessage {
  content?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }>;
}

function toOllamaMessages(request: ChatRequest) {
  return request.messages.map((m) => ({ role: m.role, content: m.content }));
}

function toOllamaTools(request: ChatRequest) {
  if (!request.tools?.length) return undefined;
  return request.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OllamaProvider implements ModelProvider {
  readonly id: ProviderId = 'ollama';
  private readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return isOllamaServerUp(this.config.baseUrl);
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model: this.config.model,
          messages: toOllamaMessages(request),
          tools: toOllamaTools(request),
          stream: true,
          options: { temperature: request.temperature, num_predict: request.maxTokens },
        }),
        // Every other network call in this codebase has a timeout; this one didn't, and a
        // live test caught the consequence — a hung/never-closing stream from Ollama blocks
        // the whole agent run forever with no way to recover (no CPU usage anywhere to even
        // show something's wrong). 2 minutes is generous for slow local inference but bounded.
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      yield { type: 'error', message: `ollama chat request failed: ${(err as Error).message}` };
      return;
    }

    if (!res.ok || !res.body) {
      yield { type: 'error', message: `ollama chat failed: ${res.status}` };
      return;
    }

    // Ollama streams tool_calls on an earlier chunk (done:false) and the final
    // done:true chunk carries no message content — so "did we see a tool call"
    // has to be tracked across the whole stream, not read off the last chunk.
    let toolCallIndex = 0;
    let sawToolCall = false;
    try {
      for await (const parsed of readNdjson<{
        message?: OllamaResponseMessage;
        done?: boolean;
        done_reason?: string;
      }>(res.body)) {
        if (parsed.message?.content) {
          yield { type: 'text', delta: parsed.message.content };
        }
        for (const call of parsed.message?.tool_calls ?? []) {
          sawToolCall = true;
          const toolCall: ToolCall = {
            id: call.id ?? `call_${toolCallIndex++}`,
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments),
          };
          yield { type: 'tool_call', toolCall };
        }
        if (parsed.done) {
          yield {
            type: 'done',
            finishReason: sawToolCall ? 'tool_calls' : parsed.done_reason === 'length' ? 'length' : 'stop',
          };
          return;
        }
      }
    } catch (err) {
      // Covers the abort firing mid-stream (CHAT_TIMEOUT_MS) as well as any other stream
      // fault — without this, an aborted read rejects inside the generator and the
      // exception propagates uncaught into the caller's `for await`, crashing the whole run
      // instead of surfacing as a normal 'error' chunk the loop already knows how to handle.
      yield { type: 'error', message: `ollama chat stream failed: ${(err as Error).message}` };
    }
  }
}
