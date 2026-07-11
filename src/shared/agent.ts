import type { ChatMessage, ToolCall } from './model';

/**
 * One classifier, used everywhere (planner, completion gate) — the prototype had this
 * triplicated (objective-policy.js, agent-loop.js, readiness.js) and each copy disagreed,
 * which is exactly how "check the weather" got misclassified as a build task and could
 * never complete (AGENT_LOOP_INVESTIGATION.md bugs #1–#3). Default is 'chat', never 'build'.
 */
export type TaskClass = 'chat' | 'lookup' | 'research' | 'build' | 'operate' | 'browse';

export type RiskTier = 'read' | 'write' | 'sensitive' | 'deny';

export interface ToolResult {
  tool: string;
  ok: boolean;
  summary: string;
  output?: string;
}

export interface RunBudgets {
  maxIterations: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
}

export type AgentEvent =
  | { type: 'classified'; taskClass: TaskClass }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCall: ToolCall; result: ToolResult }
  | { type: 'approval_needed'; approvalId: string; tool: string; argsSummary: string; riskTier: RiskTier }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'done'; success: boolean; reason: string; reflection?: string }
  | { type: 'error'; message: string };

export interface PendingApproval {
  id: string;
  tool: string;
  argsSummary: string;
  riskTier: RiskTier;
  createdAt: number;
}

export interface RunRequest {
  objective: string;
  workspaceRoot: string;
  budgets?: Partial<RunBudgets>;
  /** Prior user/assistant turns of the same conversation — lets the chat surface drive
   * the full agent runtime (one Jarvis-style conversation) without losing context. */
  history?: ChatMessage[];
}

export interface RunResult {
  success: boolean;
  reason: string;
  messages: ChatMessage[];
  iterations: number;
  toolCalls: number;
  reflection?: string;
}
