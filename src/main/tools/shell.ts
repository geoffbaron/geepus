import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyRunCommand } from '../policy/rules';
import type { ToolHandler } from './types';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 20_000;
const TIMEOUT_MS = 5 * 60_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : text;
}

export const runCommandTool: ToolHandler = {
  definition: {
    name: 'run_command',
    description: 'Run a shell command in the workspace. Only allowlisted commands run automatically; anything else asks for approval.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The full shell command to run.' } },
      required: ['command'],
    },
  },
  riskTier: (args) => classifyRunCommand(String(args['command'] ?? '')),
  summarize: (args) => `Run: ${String(args['command'])}`,
  execute: async (args, context) => {
    const command = String(args['command'] ?? '');
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: context.workspaceRoot,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = truncate(`${stdout}${stderr}`.trim());
      return { tool: 'run_command', ok: true, summary: `Exit 0: ${command}`, output };
    } catch (err) {
      const execErr = err as Error & { stdout?: string; stderr?: string; code?: number };
      const output = truncate(`${execErr.stdout ?? ''}${execErr.stderr ?? ''}`.trim());
      return { tool: 'run_command', ok: false, summary: `Failed (exit ${execErr.code ?? '?'}): ${command}`, output };
    }
  },
};
