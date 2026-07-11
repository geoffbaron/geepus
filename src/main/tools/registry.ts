import type { ToolDefinition } from '@shared/model';
import type { ToolResult } from '@shared/agent';
import { listFilesTool, readFileTool, writeFileTool } from './fs';
import { runCommandTool } from './shell';
import { httpGetTool } from './web';
import { recallTool, rememberTool } from './memory';
import { BROWSER_TOOLS } from './browser';
import type { ToolContext, ToolHandler } from './types';
import { requestApproval } from '../policy/approvals';
import type { AuditLog } from '../policy/audit';

const TOOLS: ToolHandler[] = [
  readFileTool,
  listFilesTool,
  writeFileTool,
  runCommandTool,
  httpGetTool,
  rememberTool,
  recallTool,
  ...BROWSER_TOOLS,
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.definition.name, t]));

export function getToolDefinitions(): ToolDefinition[] {
  return TOOLS.map((t) => t.definition);
}

export interface ExecuteToolOptions {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolContext;
  auditLog?: AuditLog;
}

function findMissingRequiredArg(handler: ToolHandler, args: Record<string, unknown>): string | null {
  const required = handler.definition.parameters['required'];
  if (!Array.isArray(required)) return null;
  for (const key of required) {
    if (typeof key === 'string' && !(key in args)) return key;
  }
  return null;
}

/**
 * Every tool call flows through here: required-argument validation, risk classification,
 * hard-deny short circuit, approval gating for 'sensitive' calls, then execution, then an
 * audit log entry regardless of outcome (PLAN.md §9 — no execution path skips the audit trail).
 *
 * The missing-argument check runs BEFORE risk classification and matters more than it looks:
 * weaker models (observed live with a 1B Ollama model) sometimes emit malformed/mis-nested
 * tool-call arguments. Without this check, a call like http_get with no `url` would stringify
 * to "undefined", fail URL parsing, get classified 'sensitive', and block forever waiting on
 * an approval for a request that was never coherent to begin with — a real deadlock caught by
 * a live test, not a hypothetical. Failing fast here turns it into a normal tool-error message
 * the model can see and self-correct from on the next iteration instead.
 */
export async function executeTool(options: ExecuteToolOptions): Promise<ToolResult> {
  const handler = TOOL_MAP.get(options.toolName);
  if (!handler) {
    return { tool: options.toolName, ok: false, summary: `Unknown tool: ${options.toolName}` };
  }

  const missingArg = findMissingRequiredArg(handler, options.args);
  if (missingArg) {
    return { tool: options.toolName, ok: false, summary: `Missing required argument: ${missingArg}` };
  }

  const riskTier = handler.riskTier(options.args, options.context);
  const summary = handler.summarize(options.args);

  if (riskTier === 'deny') {
    await options.auditLog?.append({ tool: options.toolName, argsSummary: summary, riskTier, decision: 'hard-denied' });
    return { tool: options.toolName, ok: false, summary: `Blocked: ${summary} (hard-denied by policy)` };
  }

  if (riskTier === 'sensitive') {
    const approved = await requestApproval({ tool: options.toolName, argsSummary: summary, riskTier });
    if (!approved) {
      await options.auditLog?.append({ tool: options.toolName, argsSummary: summary, riskTier, decision: 'denied' });
      return { tool: options.toolName, ok: false, summary: `Not approved: ${summary}` };
    }
    const result = await handler.execute(options.args, options.context);
    await options.auditLog?.append({
      tool: options.toolName,
      argsSummary: summary,
      riskTier,
      decision: 'approved',
      resultOk: result.ok,
    });
    return result;
  }

  const result = await handler.execute(options.args, options.context);
  await options.auditLog?.append({
    tool: options.toolName,
    argsSummary: summary,
    riskTier,
    decision: 'auto-allowed',
    resultOk: result.ok,
  });
  return result;
}
