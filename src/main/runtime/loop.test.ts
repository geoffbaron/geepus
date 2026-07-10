import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runObjective } from './loop';
import type { AgentEvent } from '@shared/agent';
import type { ChatChunk, ChatRequest, ProviderId } from '@shared/model';
import type { ModelProvider } from '../models/provider';

/** A scripted provider: each call to chat() consumes the next script entry, so tests can
 * drive the loop through exact multi-turn scenarios without a real (or mocked-fetch) LLM. */
class ScriptedProvider implements ModelProvider {
  readonly id: ProviderId = 'ollama';
  private callIndex = 0;
  constructor(private readonly script: Array<(request: ChatRequest) => ChatChunk[]>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const turn = this.script[this.callIndex] ?? (() => [{ type: 'done' as const, finishReason: 'stop' as const }]);
    this.callIndex += 1;
    for (const chunk of turn(request)) yield chunk;
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('runObjective', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-loop-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('classifies the objective exactly once, up front', async () => {
    const provider = new ScriptedProvider([() => [{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]]);
    const events = await collect(runObjective({ objective: 'hello there', workspaceRoot, provider }));
    const classified = events.filter((e) => e.type === 'classified');
    expect(classified).toHaveLength(1);
    expect((classified[0] as { taskClass: string }).taskClass).toBe('chat');
  });

  // The canonical regression scenario from AGENT_LOOP_INVESTIGATION.md: a lookup task
  // that succeeds via a single non-build tool call must complete in very few iterations,
  // not loop forever waiting for a write_file/run_command that will never come.
  it('regression: a lookup task completes within 3 iterations on a successful http_get (bugs #1-#3)', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        expect(req.messages.some((m) => m.role === 'system' && /lookup/.test(m.content))).toBe(true);
        return [
          {
            type: 'tool_call',
            toolCall: { id: 'call_1', name: 'http_get', arguments: JSON.stringify({ url: 'https://api.github.com/zen' }) },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ];
      },
      () => [{ type: 'text', delta: 'Here is the answer.' }, { type: 'done', finishReason: 'stop' }],
      () => [{ type: 'text', delta: 'reflection: nothing notable' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const events = await collect(runObjective({ objective: 'check the weather', workspaceRoot, provider }));

    const classified = events.find((e) => e.type === 'classified') as { taskClass: string };
    expect(classified.taskClass).toBe('lookup');

    const iterationStarts = events.filter((e) => e.type === 'iteration_start');
    expect(iterationStarts.length).toBeLessThanOrEqual(3);

    const done = events.find((e) => e.type === 'done') as { success: boolean };
    expect(done.success).toBe(true);
  });

  it('executes a tool call and feeds the result back as a tool message', async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: 'tool_call', toolCall: { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hi' }) } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      () => [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
    ]);

    const events = await collect(runObjective({ objective: 'build a script', workspaceRoot, provider }));
    const toolResult = events.find((e) => e.type === 'tool_result') as { result: { ok: boolean } };
    expect(toolResult.result.ok).toBe(true);

    const done = events.find((e) => e.type === 'done') as { success: boolean; reason: string };
    expect(done.success).toBe(true);
  });

  it('stops at the iteration budget and reports failure if never complete', async () => {
    // A build objective with only text responses (no write_file/run_command) never
    // satisfies the completion gate, so this should run out the full iteration budget.
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }, () => () => [{ type: 'text', delta: 'thinking' }, { type: 'done', finishReason: 'stop' }] as ChatChunk[]),
    );
    const events = await collect(
      runObjective({ objective: 'build a todo app', workspaceRoot, provider, budgets: { maxIterations: 3 } }),
    );
    const done = events.find((e) => e.type === 'done') as { success: boolean; reason: string };
    expect(done.success).toBe(false);
    expect(done.reason).toMatch(/iteration budget/i);
    expect(events.filter((e) => e.type === 'iteration_start')).toHaveLength(3);
  });

  it('stops at the tool-call budget', async () => {
    const provider = new ScriptedProvider([
      () => [
        { type: 'tool_call', toolCall: { id: 'c1', name: 'read_file', arguments: '{"path":"missing.txt"}' } },
        { type: 'tool_call', toolCall: { id: 'c2', name: 'read_file', arguments: '{"path":"missing.txt"}' } },
        { type: 'tool_call', toolCall: { id: 'c3', name: 'read_file', arguments: '{"path":"missing.txt"}' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ]);
    const events = await collect(
      runObjective({ objective: 'build something', workspaceRoot, provider, budgets: { maxToolCalls: 2 } }),
    );
    const done = events.find((e) => e.type === 'done') as { success: boolean; reason: string };
    expect(done.success).toBe(false);
    expect(done.reason).toMatch(/tool call budget/i);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('surfaces a provider error and stops', async () => {
    const provider = new ScriptedProvider([() => [{ type: 'error', message: 'model unavailable' }]]);
    const events = await collect(runObjective({ objective: 'hi', workspaceRoot, provider }));
    const done = events.find((e) => e.type === 'done') as { success: boolean; reason: string };
    expect(done.success).toBe(false);
    expect(done.reason).toBe('model unavailable');
  });

  it('includes a best-effort reflection on a successful completion', async () => {
    const provider = new ScriptedProvider([
      () => [{ type: 'text', delta: 'hello!' }, { type: 'done', finishReason: 'stop' }],
      () => [{ type: 'text', delta: 'Nothing notable.' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const events = await collect(runObjective({ objective: 'hi', workspaceRoot, provider }));
    const done = events.find((e) => e.type === 'done') as { reflection?: string };
    expect(done.reflection).toBe('Nothing notable.');
  });
});
