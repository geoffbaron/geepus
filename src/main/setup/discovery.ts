import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredRuntime, DiscoveryReport, LooseModelFile } from '@shared/setup';
import { findOllamaBinary, isOllamaServerUp, listOllamaModelsDetailed } from '../models/ollama';

const LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';

async function discoverOllama(): Promise<DiscoveredRuntime> {
  const [binaryPath, serverUp] = await Promise.all([findOllamaBinary(), isOllamaServerUp()]);
  const models = serverUp ? await listOllamaModelsDetailed().catch(() => []) : [];
  return { id: 'ollama', available: serverUp, binaryFound: Boolean(binaryPath), models };
}

async function discoverLmStudio(): Promise<DiscoveredRuntime> {
  try {
    const res = await fetch(`${LM_STUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { id: 'lmstudio', available: false, binaryFound: false, models: [] };
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return {
      id: 'lmstudio',
      available: true,
      binaryFound: true,
      models: (data.data ?? []).map((m) => ({ name: m.id, sizeGb: 0 })),
    };
  } catch {
    return { id: 'lmstudio', available: false, binaryFound: false, models: [] };
  }
}

// Top-level only, no recursive crawl — this is a quick "did you already download a GGUF
// somewhere obvious" check, not a filesystem search (PLAN.md §6.2).
const LOOSE_MODEL_DIRS = [join(homedir(), 'models'), join(homedir(), 'Downloads')];

async function scanLooseModelFiles(): Promise<LooseModelFile[]> {
  const found: LooseModelFile[] = [];
  for (const dir of LOOSE_MODEL_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // directory doesn't exist — skip
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.gguf')) continue;
      const fullPath = join(dir, entry);
      try {
        const info = await stat(fullPath);
        found.push({ path: fullPath, sizeGb: Math.round((info.size / 1024 ** 3) * 10) / 10 });
      } catch {
        // unreadable — skip
      }
    }
  }
  return found;
}

export async function discoverRuntimes(): Promise<DiscoveryReport> {
  const [ollama, lmstudio, looseFiles] = await Promise.all([
    discoverOllama(),
    discoverLmStudio(),
    scanLooseModelFiles(),
  ]);
  return { runtimes: [ollama, lmstudio], looseFiles };
}
