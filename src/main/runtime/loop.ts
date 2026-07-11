import type { ChatMessage, ChatRequest, ToolCall } from '@shared/model';
import type { AgentEvent, RunBudgets, TaskClass, ToolResult } from '@shared/agent';
import type { ModelProvider } from '../models/provider';
import type { AuditLog } from '../policy/audit';
import type { MemoryService } from '../memory/service';
import { getToolDefinitions, executeTool } from '../tools/registry';
import { proposeBrowserControllerIfApplicable } from '../browser/controllerProposal';
import { classifyObjective } from './classify';
import { checkCompletion } from './complete';

const DEFAULT_BUDGETS: RunBudgets = {
  maxIterations: 8,
  maxToolCalls: 20,
  maxRuntimeMs: 5 * 60_000,
};

export interface RunObjectiveOptions {
  objective: string;
  workspaceRoot: string;
  provider: ModelProvider;
  budgets?: Partial<RunBudgets>;
  auditLog?: AuditLog;
  /** Optional — when provided, relevant learned strategies/skills are injected into the
   * system prompt, and a successful run's outcome is recorded back into memory (M4). */
  memory?: MemoryService;
  /** Prior user/assistant turns of the same conversation, inserted between the system
   * prompt and the current objective. Tool/system entries are filtered out — stale tool
   * call ids from a previous run would confuse providers that validate them. */
  history?: ChatMessage[];
}

async function systemPromptFor(
  taskClass: TaskClass,
  tools: ReturnType<typeof getToolDefinitions>,
  objective: string,
  workspaceRoot: string,
  memory: MemoryService | undefined,
): Promise<string> {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const lines = [
    'You are Geepus, a local-only digital assistant.',
    `The current task is classified as "${taskClass}".`,
  ];
  if (taskClass === 'lookup' || taskClass === 'research') {
    lines.push('Answer as soon as you have the information — do not write files or run commands unless the user actually asked for that.');
  }
  lines.push('Available tools:', toolList, 'Call a tool when you need to. When you have a final answer, respond with plain text and no tool calls.');

  if (memory) {
    // Two distinct sources: general remembered notes (recall) and learned strategies/skills
    // from past runs (getPromptContext) — both matter to the planner, neither subsumes the other.
    const [recallContext, strategyContext] = await Promise.all([
      memory.recallPrompt(objective, workspaceRoot).catch(() => ''),
      memory.getPromptContext(objective).catch(() => ''),
    ]);
    if (recallContext) lines.push(recallContext);
    if (strategyContext) lines.push(strategyContext);
  }

  return lines.join('\n\n');
}

function parseToolArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The plan→act→observe loop (PLAN.md §4). Deliberately small: classify once, call the
 * model, execute any tool calls through the policy-gated registry, check the task-class-
 * aware completion gate, repeat. Native tool-calling only for now (Ollama/OpenRouter) —
 * a JSON-fallback protocol for providers without native tool support (the bundled model)
 * is a follow-up, not required for this milestone's accept criteria.
 */
export async function* runObjective(options: RunObjectiveOptions): AsyncGenerator<AgentEvent> {
  const budgets: RunBudgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const taskClass = classifyObjective(options.objective);
  yield { type: 'classified', taskClass };

  const tools = getToolDefinitions();
  const priorTurns = (options.history ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .map((m): ChatMessage => ({ role: m.role, content: m.content }))
    .slice(-20); // bounded — old turns matter less than blowing the context window
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: await systemPromptFor(taskClass, tools, options.objective, options.workspaceRoot, options.memory),
    },
    ...priorTurns,
    { role: 'user', content: options.objective },
  ];

  const toolResults: ToolResult[] = [];
  const toolCallLog: Array<{ call: ToolCall; result: ToolResult }> = [];
  let toolCallCount = 0;
  const startTime = Date.now();
  let iteration = 0;

  while (iteration < budgets.maxIterations) {
    if (Date.now() - startTime > budgets.maxRuntimeMs) {
      yield { type: 'done', success: false, reason: 'Runtime budget exceeded.' };
      return;
    }
    iteration += 1;
    yield { type: 'iteration_start', iteration };

    // Bounds worst-case generation length per turn (defense in depth alongside the provider-
    // level stream timeout) — a small/weak model left uncapped can generate a very long,
    // repetitive response before ever emitting a stop token.
    const request: ChatRequest = { messages, tools, maxTokens: 2048 };
    let assistantText = '';
    const pendingCalls: ToolCall[] = [];
    let sawError: string | null = null;

    for await (const chunk of options.provider.chat(request)) {
      if (chunk.type === 'text') {
        assistantText += chunk.delta;
        yield { type: 'text', delta: chunk.delta };
      } else if (chunk.type === 'tool_call') {
        pendingCalls.push(chunk.toolCall);
        yield { type: 'tool_call', toolCall: chunk.toolCall };
      } else if (chunk.type === 'error') {
        sawError = chunk.message;
      }
    }

    if (sawError) {
      yield { type: 'error', message: sawError };
      yield { type: 'done', success: false, reason: sawError };
      return;
    }

    messages.push({
      role: 'assistant',
      content: assistantText,
      toolCalls: pendingCalls.length ? pendingCalls : undefined,
    });

    if (pendingCalls.length > 0) {
      let budgetExceeded = false;
      for (const call of pendingCalls) {
        if (toolCallCount >= budgets.maxToolCalls) {
          budgetExceeded = true;
          break;
        }
        toolCallCount += 1;
        const result = await executeTool({
          toolName: call.name,
          args: parseToolArgs(call),
          context: { workspaceRoot: options.workspaceRoot },
          auditLog: options.auditLog,
        });
        toolResults.push(result);
        toolCallLog.push({ call, result });
        yield { type: 'tool_result', toolCall: call, result };
        messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: call.id });
      }
      if (budgetExceeded) {
        yield { type: 'done', success: false, reason: 'Tool call budget exceeded.' };
        return;
      }
    }

    const completion = checkCompletion(taskClass, toolResults, assistantText.trim().length > 0 && pendingCalls.length === 0);
    if (completion.done) {
      const reflection = await tryReflect(options.provider, messages);
      if (options.memory) {
        await options.memory
          .recordRunOutcome({
            objective: options.objective,
            workspaceRoot: options.workspaceRoot,
            success: true,
            reflection,
            toolSequence: toolResults.map((r) => r.tool),
          })
          .catch(() => {
            // Memory recording is best-effort — a failure here must never fail the run itself.
          });
      }
      if (taskClass === 'browse') {
        // Successful site flows become replayable playbooks (PLAN.md §7 item 5) — proposed
        // only, never auto-promoted to active (that needs a verified successful replay).
        await proposeBrowserControllerIfApplicable({
          objective: options.objective,
          workspaceRoot: options.workspaceRoot,
          calls: toolCallLog,
        }).catch(() => {
          // Best-effort, same as memory recording above.
        });
      }
      yield { type: 'done', success: true, reason: completion.reason, reflection };
      return;
    }
  }

  yield { type: 'done', success: false, reason: 'Iteration budget exceeded.' };
}

/** One extra model call at the end of a run: what worked, what to remember for next time
 * (PLAN.md §4 item 5). Best-effort — persistence into MemoryService lands in M4. */
async function tryReflect(provider: ModelProvider, messages: ChatMessage[]): Promise<string | undefined> {
  try {
    const reflectionRequest: ChatRequest = {
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            'In one short sentence, note anything worth remembering about how you solved this for next time (or say "nothing notable").',
        },
      ],
      maxTokens: 200,
    };
    let text = '';
    for await (const chunk of provider.chat(reflectionRequest)) {
      if (chunk.type === 'text') text += chunk.delta;
      if (chunk.type === 'done' || chunk.type === 'error') break;
    }
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}
