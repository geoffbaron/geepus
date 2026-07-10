import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { classifyFsPath } from '../policy/rules';
import type { ToolContext, ToolHandler } from './types';

function resolveArgPath(args: Record<string, unknown>, context: ToolContext): string {
  const rawPath = String(args['path'] ?? '');
  return resolve(context.workspaceRoot, rawPath);
}

export const readFileTool: ToolHandler = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a text file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path, relative to the workspace unless absolute.' } },
      required: ['path'],
    },
  },
  riskTier: (args, context) => classifyFsPath(resolveArgPath(args, context), context.workspaceRoot, 'read'),
  summarize: (args) => `Read ${String(args['path'])}`,
  execute: async (args, context) => {
    const path = resolveArgPath(args, context);
    try {
      const content = await readFile(path, 'utf8');
      return { tool: 'read_file', ok: true, summary: `Read ${content.length} chars from ${path}`, output: content };
    } catch (err) {
      return { tool: 'read_file', ok: false, summary: `Failed to read ${path}: ${(err as Error).message}` };
    }
  },
};

export const listFilesTool: ToolHandler = {
  definition: {
    name: 'list_files',
    description: 'List files and folders in a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, relative to the workspace unless absolute. Defaults to the workspace root.' } },
    },
  },
  riskTier: (args, context) => classifyFsPath(resolveArgPath({ path: args['path'] ?? '.' }, context), context.workspaceRoot, 'read'),
  summarize: (args) => `List ${String(args['path'] ?? '.')}`,
  execute: async (args, context) => {
    const path = resolveArgPath({ path: args['path'] ?? '.' }, context);
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { tool: 'list_files', ok: true, summary: `${listing.length} entries in ${path}`, output: listing.join('\n') };
    } catch (err) {
      return { tool: 'list_files', ok: false, summary: `Failed to list ${path}: ${(err as Error).message}` };
    }
  },
};

export const writeFileTool: ToolHandler = {
  definition: {
    name: 'write_file',
    description: 'Write (create or overwrite) a text file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace unless absolute.' },
        content: { type: 'string', description: 'The full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  riskTier: (args, context) => classifyFsPath(resolveArgPath(args, context), context.workspaceRoot, 'write'),
  summarize: (args) => `Write ${String(args['path'])} (${String(args['content'] ?? '').length} chars)`,
  execute: async (args, context) => {
    const path = resolveArgPath(args, context);
    const content = String(args['content'] ?? '');
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return { tool: 'write_file', ok: true, summary: `Wrote ${content.length} chars to ${path}` };
    } catch (err) {
      return { tool: 'write_file', ok: false, summary: `Failed to write ${path}: ${(err as Error).message}` };
    }
  },
};

/** Exposed for tests that want to assert a path resolves/escapes the workspace without executing anything. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
