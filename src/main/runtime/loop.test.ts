import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { proposeBrowserControllerIfApplicable, mockGoto } = vi.hoisted(() => ({
  proposeBrowserControllerIfApplicable: vi.fn().mockResolvedValue(null),
  mockGoto: vi.fn().mockResolvedValue('URL: https://example.com'),
}));
vi.mock('../browser/controllerProposal', () => ({ proposeBrowserControllerIfApplicable }));

// Never launch a real Chromium instance from this unit test file — these tests only care
// about the wiring from loop.ts into proposeBrowserControllerIfApplicable, not actual
// browser behavior (that's covered live in browser/session live-testing).
vi.mock('../browser/instance', () => ({
  getBrowserSession: () => ({ goto: mockGoto }),
}));

import { runObjective } from './loop';
import type { AgentEvent } from '@shared/agent';
import type { ChatChunk, ChatRequest, ProviderId } from '@shared/model';
import type { ModelProvider } from '../models/provider';
import { MemoryService } from '../memory/service';

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

  describe('memory integration (M4)', () => {
    let memoryDir: string;
    let memory: MemoryService;

    beforeEach(async () => {
      memoryDir = await mkdtemp(join(tmpdir(), 'geepus-loop-memory-test-'));
      memory = new MemoryService({ dataDir: memoryDir });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('use local hash embeddings in tests')));
    });

    afterEach(async () => {
      await rm(memoryDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    });

    it('injects relevant memory context into the system prompt when a memory service is provided', async () => {
      await memory.remember('always double check the spelling of place names', undefined);

      let sawContextInPrompt = false;
      const provider = new ScriptedProvider([
        (req) => {
          const systemMessage = req.messages.find((m) => m.role === 'system');
          sawContextInPrompt = Boolean(systemMessage && systemMessage.content.includes('spelling of place names'));
          return [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }];
        },
        () => [{ type: 'text', delta: 'Nothing notable.' }, { type: 'done', finishReason: 'stop' }],
      ]);

      await collect(runObjective({ objective: 'double check the spelling of place names in this doc', workspaceRoot, provider, memory }));
      expect(sawContextInPrompt).toBe(true);
    });

    it('records the run outcome to memory on successful completion, before done resolves', async () => {
      // Only two provider calls happen here, not three: the 'build' completion gate is
      // satisfied as soon as write_file succeeds in iteration 1 (checked at the end of every
      // iteration), so the loop goes straight from that tool call to the reflection call —
      // there's no separate "final answer" turn in between.
      const provider = new ScriptedProvider([
        () => [
          { type: 'tool_call', toolCall: { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hi' }) } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        () => [
          { type: 'text', delta: 'when you build a summary generator, always write the summary file first' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]);

      await collect(runObjective({ objective: 'build a summary generator', workspaceRoot, provider, memory }));

      // recordRunOutcome already resolved by the time the generator finished (awaited, not fire-and-forget).
      const context = await memory.getPromptContext('build a summary generator');
      expect(context).toContain('summary file');
    });

    it('does not fail the run if memory recording throws', async () => {
      const brokenMemory = {
        getPromptContext: vi.fn().mockResolvedValue(''),
        recallPrompt: vi.fn().mockResolvedValue(''),
        recordRunOutcome: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as MemoryService;

      const provider = new ScriptedProvider([
        () => [{ type: 'text', delta: 'hello!' }, { type: 'done', finishReason: 'stop' }],
        () => [{ type: 'text', delta: 'Nothing notable.' }, { type: 'done', finishReason: 'stop' }],
      ]);

      const events = await collect(runObjective({ objective: 'hi', workspaceRoot, provider, memory: brokenMemory }));
      const done = events.find((e) => e.type === 'done') as { success: boolean };
      expect(done.success).toBe(true);
    });
  });

  describe('browser controller proposal wiring (M6)', () => {
    beforeEach(() => proposeBrowserControllerIfApplicable.mockClear());

    it('proposes a controller spec after a successful browse-classified run', async () => {
      const provider = new ScriptedProvider([
        () => [
          { type: 'tool_call', toolCall: { id: 'c1', name: 'browser_goto', arguments: JSON.stringify({ url: 'https://example.com' }) } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
      ]);
      // "buy" classifies as 'browse' per classify.ts's BROWSE_PATTERNS.
      await collect(runObjective({ objective: 'buy this item on example.com', workspaceRoot, provider }));
      expect(proposeBrowserControllerIfApplicable).toHaveBeenCalledOnce();
      const [args] = proposeBrowserControllerIfApplicable.mock.calls[0]!;
      expect(args.calls).toHaveLength(1);
      expect(args.calls[0].call.name).toBe('browser_goto');
    });

    it('does not propose a controller spec for a non-browse task class', async () => {
      const provider = new ScriptedProvider([
        () => [{ type: 'text', delta: 'hello!' }, { type: 'done', finishReason: 'stop' }],
        () => [{ type: 'text', delta: 'Nothing notable.' }, { type: 'done', finishReason: 'stop' }],
      ]);
      await collect(runObjective({ objective: 'hi', workspaceRoot, provider }));
      expect(proposeBrowserControllerIfApplicable).not.toHaveBeenCalled();
    });

    it('does not fail the run if proposing a controller spec throws', async () => {
      proposeBrowserControllerIfApplicable.mockRejectedValueOnce(new Error('disk full'));
      const provider = new ScriptedProvider([
        () => [
          { type: 'tool_call', toolCall: { id: 'c1', name: 'browser_goto', arguments: JSON.stringify({ url: 'https://example.com' }) } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
      ]);
      const events = await collect(runObjective({ objective: 'buy this item on example.com', workspaceRoot, provider }));
      const done = events.find((e) => e.type === 'done') as { success: boolean };
      expect(done.success).toBe(true);
    });
  });
});
