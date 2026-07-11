import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cosineSimilarity } from './embeddings';

export interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  embeddingModel: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

interface StoreFile {
  entries: VectorEntry[];
}

const MAX_VECTORS_PER_NAMESPACE = 5000;

export interface SearchHit {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  /** Called for any entry whose stored embeddingModel differs from the query's — the
   * result is persisted back into the store. Without this, mismatched entries are
   * skipped (same as the prototype); with it, they're upgraded lazily instead of lost
   * (PLAN.md §8 item 6). */
  reembed?: (text: string) => Promise<{ vector: number[]; model: string }>;
}

/** File-backed, namespaced vector store — one JSON file per namespace, brute-force
 * cosine search (fine under ~10K vectors, same ceiling the prototype accepted). */
export class VectorStore {
  private readonly dir: string;
  private readonly cache = new Map<string, VectorEntry[]>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(namespace: string): string {
    const safe = namespace.replace(/[^a-z0-9_-]/gi, '_');
    return join(this.dir, `${safe}.json`);
  }

  private async load(namespace: string): Promise<VectorEntry[]> {
    const cached = this.cache.get(namespace);
    if (cached) return cached;
    try {
      const raw = await readFile(this.fileFor(namespace), 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.cache.set(namespace, entries);
      return entries;
    } catch {
      const empty: VectorEntry[] = [];
      this.cache.set(namespace, empty);
      return empty;
    }
  }

  private async save(namespace: string): Promise<void> {
    const entries = this.cache.get(namespace) ?? [];
    const file = this.fileFor(namespace);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
  }

  async add(
    namespace: string,
    text: string,
    embedding: number[],
    embeddingModel: string,
    metadata: Record<string, unknown> = {},
  ): Promise<VectorEntry> {
    const entries = await this.load(namespace);
    const existingIndex = entries.findIndex((e) => e.text === text);
    if (existingIndex !== -1) {
      const existing = entries[existingIndex]!;
      const updated: VectorEntry = {
        ...existing,
        embedding,
        embeddingModel,
        metadata: { ...existing.metadata, ...metadata },
        updatedAt: Date.now(),
      };
      entries[existingIndex] = updated;
      await this.save(namespace);
      return updated;
    }

    const entry: VectorEntry = {
      id: randomUUID(),
      text: text.slice(0, 8000),
      embedding,
      embeddingModel,
      metadata,
      createdAt: Date.now(),
    };
    entries.push(entry);
    while (entries.length > MAX_VECTORS_PER_NAMESPACE) entries.shift();

    await this.save(namespace);
    return entry;
  }

  async remove(namespace: string, id: string): Promise<boolean> {
    const entries = await this.load(namespace);
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) return false;
    entries.splice(index, 1);
    await this.save(namespace);
    return true;
  }

  async list(namespace: string): Promise<VectorEntry[]> {
    return [...(await this.load(namespace))];
  }

  async clear(namespace: string): Promise<void> {
    this.cache.set(namespace, []);
    await this.save(namespace);
  }

  async search(
    namespace: string,
    queryEmbedding: number[],
    queryModel: string,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const topK = options.topK ?? 8;
    const minSimilarity = options.minSimilarity ?? 0.15;
    const entries = await this.load(namespace);
    if (entries.length === 0) return [];

    let dirty = false;
    const scored: SearchHit[] = [];

    for (const entry of entries) {
      let embedding = entry.embedding;
      if (entry.embeddingModel !== queryModel && options.reembed) {
        const reembedded = await options.reembed(entry.text);
        entry.embedding = reembedded.vector;
        entry.embeddingModel = reembedded.model;
        entry.updatedAt = Date.now();
        embedding = reembedded.vector;
        dirty = true;
      }
      if (embedding.length !== queryEmbedding.length) continue; // still mismatched (no reembed fn) — skip, don't crash
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= minSimilarity) {
        scored.push({ id: entry.id, text: entry.text, metadata: entry.metadata, similarity: Math.round(similarity * 1000) / 1000 });
      }
    }

    if (dirty) await this.save(namespace);

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  async stats(namespace: string): Promise<{ count: number }> {
    return { count: (await this.load(namespace)).length };
  }

  async listNamespaces(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /** Drops exact-duplicate text entries, keeping the most recently updated copy —
   * one part of nightly consolidation (PLAN.md §8 item 5). */
  async dedupe(namespace: string): Promise<number> {
    const entries = await this.load(namespace);
    const seen = new Map<string, VectorEntry>();
    for (const entry of entries) {
      const existing = seen.get(entry.text);
      if (!existing || (entry.updatedAt ?? entry.createdAt) >= (existing.updatedAt ?? existing.createdAt)) {
        seen.set(entry.text, entry);
      }
    }
    const deduped = [...seen.values()];
    const removed = entries.length - deduped.length;
    if (removed > 0) {
      this.cache.set(namespace, deduped);
      await this.save(namespace);
    }
    return removed;
  }
}
