import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from './openrouter';
import type { ChatChunk } from '@shared/model';

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('OpenRouterProvider.chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams text deltas and a final done chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          '[DONE]',
        ]),
      ),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' });
    const chunks = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(chunks).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('accumulates streamed tool-call argument deltas into one complete call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Blaine"}' } }] }, finish_reason: 'tool_calls' }],
          }),
          '[DONE]',
        ]),
      ),
    );

    const provider = new OpenRouterProvider({ apiKey: 'test-key', model: 'test-model' });
    const chunks = await collect(
      provider.chat({
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', description: 'get weather', parameters: {} }],
      }),
    );

    expect(chunks).toEqual([
      {
        type: 'tool_call',
        toolCall: { id: 'call_1', name: 'get_weather', arguments: '{"city":"Blaine"}' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('yields an error chunk on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));

    const provider = new OpenRouterProvider({ apiKey: 'bad-key', model: 'test-model' });
    const chunks = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
  });

  it('isAvailable reflects whether an API key is configured', async () => {
    expect(await new OpenRouterProvider({ apiKey: '', model: 'm' }).isAvailable()).toBe(false);
    expect(await new OpenRouterProvider({ apiKey: 'k', model: 'm' }).isAvailable()).toBe(true);
  });
});
