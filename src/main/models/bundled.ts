import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatChunk, ChatRequest, ProviderId } from '@shared/model';
import type { ModelProvider } from './provider';

/**
 * Pinned tiny starter-brain model — Qwen2.5-1.5B-Instruct Q4_K_M (~1.07GB).
 * The checksum locks the exact bytes so a corrupted or interrupted download is
 * caught before node-llama-cpp ever loads it (PLAN.md §6.5).
 */
export const BUNDLED_MODEL = {
  filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  sizeBytes: 1_117_320_736,
};

export interface EnsureBundledModelOptions {
  /** resources/models/<filename> in the "full" packaged build — used as-is, never re-downloaded. */
  bakedPath?: string;
  /** userData/models/<filename> — the "lite" build's first-run download cache. */
  cachePath: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  /** Overridable for tests only — production callers rely on the BUNDLED_MODEL default. */
  url?: string;
  expectedSha256?: string;
  expectedSizeBytes?: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** Resolves the path to a checksum-verified bundled model, downloading it if necessary. */
export async function ensureBundledModel(options: EnsureBundledModelOptions): Promise<string> {
  const url = options.url ?? BUNDLED_MODEL.url;
  const expectedSha256 = options.expectedSha256 ?? BUNDLED_MODEL.sha256;
  const expectedSizeBytes = options.expectedSizeBytes ?? BUNDLED_MODEL.sizeBytes;

  if (options.bakedPath && (await fileExists(options.bakedPath))) {
    return options.bakedPath;
  }

  if (await fileExists(options.cachePath)) {
    if ((await sha256File(options.cachePath)) === expectedSha256) return options.cachePath;
    await unlink(options.cachePath); // corrupted or stale — re-download below
  }

  await mkdir(dirname(options.cachePath), { recursive: true });
  const tmpPath = `${options.cachePath}.download`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`bundled model download failed: ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? expectedSizeBytes);
  let downloaded = 0;
  const writeStream = createWriteStream(tmpPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      options.onProgress?.(downloaded, total);
      if (!writeStream.write(value)) {
        await new Promise<void>((resolve) => writeStream.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    writeStream.destroy();
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  const hash = await sha256File(tmpPath);
  if (hash !== expectedSha256) {
    await unlink(tmpPath).catch(() => {});
    throw new Error(`bundled model checksum mismatch: expected ${expectedSha256}, got ${hash}`);
  }
  await rename(tmpPath, options.cachePath);
  return options.cachePath;
}

/** Minimal pull-based async queue bridging node-llama-cpp's onTextChunk callback into an async generator. */
class ChunkQueue<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private finished = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffered.push(item);
  }

  finish(): void {
    this.finished = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.buffered.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.finished) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

/**
 * The bundled node-llama-cpp engine. Deliberately plain-text-only: tool use for
 * this provider goes through the strict-JSON fallback protocol the AgentRuntime
 * builds in M3, not node-llama-cpp's own function-calling loop — that loop executes
 * handlers internally and can't hand a pending call back to a caller, which is
 * what the ModelProvider.chat() tool_call contract requires (see PLAN.md §4).
 */
export class BundledProvider implements ModelProvider {
  readonly id: ProviderId = 'bundled';
  private readonly modelPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async isAvailable(): Promise<boolean> {
    return fileExists(this.modelPath);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getSession(systemPrompt: string | undefined): Promise<any> {
    if (this.session) return this.session;
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: this.modelPath });
    const context = await model.createContext();
    this.session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });
    return this.session;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      yield { type: 'error', message: 'bundled provider requires at least one user message' };
      return;
    }
    const systemMessage = request.messages.find((m) => m.role === 'system');

    let session;
    try {
      session = await this.getSession(systemMessage?.content);
    } catch (err) {
      yield { type: 'error', message: `failed to load bundled model: ${(err as Error).message}` };
      return;
    }

    const queue = new ChunkQueue<ChatChunk>();
    const promptPromise = session
      .prompt(lastUser.content, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        onTextChunk: (text: string) => queue.push({ type: 'text', delta: text }),
      })
      .then(() => {
        queue.push({ type: 'done', finishReason: 'stop' });
        queue.finish();
      })
      .catch((err: Error) => {
        queue.push({ type: 'error', message: err.message });
        queue.finish();
      });

    yield* queue;
    await promptPromise;
  }
}
