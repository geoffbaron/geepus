import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolHandler } from './types';

interface MemoryNote {
  text: string;
  timestamp: number;
}

/**
 * A minimal, real, file-backed memory store — not a stub. M4 replaces this with the full
 * RAG-backed MemoryService (embeddings, vector search, learned strategies); this exists so
 * the AgentRuntime has a working memory tool now instead of blocking on that milestone.
 */
function memoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.geepus', 'memory.json');
}

async function loadNotes(workspaceRoot: string): Promise<MemoryNote[]> {
  try {
    const content = await readFile(memoryPath(workspaceRoot), 'utf8');
    return JSON.parse(content) as MemoryNote[];
  } catch {
    return [];
  }
}

async function saveNotes(workspaceRoot: string, notes: MemoryNote[]): Promise<void> {
  const dir = join(workspaceRoot, '.geepus');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'memory.json'), JSON.stringify(notes, null, 2), { mode: 0o600 });
}

export const rememberTool: ToolHandler = {
  definition: {
    name: 'remember',
    description: 'Save a short note to memory for later recall (e.g. a fact you learned or a preference the user stated).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note to remember.' } },
      required: ['text'],
    },
  },
  riskTier: () => 'write',
  summarize: (args) => `Remember: ${String(args['text'])}`,
  execute: async (args, context) => {
    const text = String(args['text'] ?? '').trim();
    if (!text) return { tool: 'remember', ok: false, summary: 'Nothing to remember (empty text).' };
    const notes = await loadNotes(context.workspaceRoot);
    notes.push({ text, timestamp: Date.now() });
    await saveNotes(context.workspaceRoot, notes);
    return { tool: 'remember', ok: true, summary: `Remembered: ${text}` };
  },
};

export const recallTool: ToolHandler = {
  definition: {
    name: 'recall',
    description: 'Search remembered notes by substring match.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for in remembered notes.' } },
      required: ['query'],
    },
  },
  riskTier: () => 'read',
  summarize: (args) => `Recall: ${String(args['query'])}`,
  execute: async (args, context) => {
    const query = String(args['query'] ?? '').toLowerCase();
    const notes = await loadNotes(context.workspaceRoot);
    const matches = notes.filter((n) => n.text.toLowerCase().includes(query));
    return {
      tool: 'recall',
      ok: true,
      summary: `${matches.length} matching note(s)`,
      output: matches.map((m) => m.text).join('\n'),
    };
  },
};
