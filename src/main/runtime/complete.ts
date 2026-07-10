import type { TaskClass, ToolResult } from '@shared/agent';

export interface CompletionCheck {
  done: boolean;
  reason: string;
}

/** Only these two classes require an artifact — matches the plan's "only build requires
 * artifacts/verification" (PLAN.md §4). 'operate' groups with 'build' here since both are
 * "did the action actually happen" checks, unlike a lookup/research answer. */
const ARTIFACT_REQUIRED_CLASSES = new Set<TaskClass>(['build', 'operate']);
const ARTIFACT_TOOLS = new Set(['write_file', 'run_command']);

/**
 * Task-class-aware completion gate — the fix for AGENT_LOOP_INVESTIGATION.md bugs #2 and #3.
 * Bug #2: the prototype's hasAnyRealOutput only counted write_file/run_command/run_playwright,
 * so a successful web_search/http_request could never satisfy it. Here, any successful tool
 * result completes a lookup/research/browse/chat task — only build/operate require an artifact.
 * Bug #3: the prototype defaulted unclassified objectives to 'build', which then demanded
 * verification a lookup could never produce. classify.ts's default is 'chat', never 'build',
 * and this function has no default-to-build fallback anywhere in it.
 */
export function checkCompletion(taskClass: TaskClass, toolResults: ToolResult[], hasFinalText: boolean): CompletionCheck {
  if (taskClass === 'chat') {
    return hasFinalText
      ? { done: true, reason: 'Conversational response provided.' }
      : { done: false, reason: 'Waiting for a text response.' };
  }

  if (ARTIFACT_REQUIRED_CLASSES.has(taskClass)) {
    const hasArtifact = toolResults.some((r) => r.ok && ARTIFACT_TOOLS.has(r.tool));
    return hasArtifact
      ? { done: true, reason: 'An artifact-producing action succeeded.' }
      : { done: false, reason: 'No file write or command has succeeded yet.' };
  }

  // lookup, research, browse
  const hasAnyOutput = toolResults.some((r) => r.ok);
  if (hasAnyOutput) return { done: true, reason: 'A successful action produced output.' };
  if (hasFinalText) return { done: true, reason: 'Answered directly without needing a tool.' };
  return { done: false, reason: 'No successful action or direct answer yet.' };
}
