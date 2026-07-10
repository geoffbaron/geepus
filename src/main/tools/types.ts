import type { ToolDefinition } from '@shared/model';
import type { RiskTier, ToolResult } from '@shared/agent';

export interface ToolContext {
  workspaceRoot: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  /** Risk tier for this specific call — depends on args (e.g. a path inside vs. outside the workspace). */
  riskTier: (args: Record<string, unknown>, context: ToolContext) => RiskTier;
  /** A short, human-readable summary of what this call would do — shown in the Approvals inbox and audit log. */
  summarize: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}
