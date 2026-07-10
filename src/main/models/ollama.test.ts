import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider, isOllamaServerUp, listOllamaModelsDetailed } from './ollama';
import type { ChatChunk } from '@shared/model';

function ndjsonResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const l of lines) controller.enqueue(encoder.encode(`${l}\n`));
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

describe('OllamaProvider.chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams text deltas then a done chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({ message: { content: 'Hel' }, done: false }),
          JSON.stringify({ message: { content: 'lo' }, done: false }),
          JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
        ]),
      ),
    );

    const provider = new OllamaProvider({ model: 'llama3.2:3b' });
    const chunks = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(chunks).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('emits a tool_call chunk from a native tool-call response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            message: { content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Blaine' } } }] },
            done: true,
            done_reason: 'stop',
          }),
        ]),
      ),
    );

    const provider = new OllamaProvider({ model: 'llama3.2:3b' });
    const chunks = await collect(
      provider.chat({
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', description: 'get weather', parameters: {} }],
      }),
    );

    expect(chunks).toEqual([
      { type: 'tool_call', toolCall: { id: 'call_0', name: 'get_weather', arguments: '{"city":"Blaine"}' } },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('reports finishReason "tool_calls" even when the tool_calls arrive on an earlier chunk than done:true (real Ollama behavior)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            message: { content: '', tool_calls: [{ id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Blaine' } } }] },
            done: false,
          }),
          JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
        ]),
      ),
    );

    const provider = new OllamaProvider({ model: 'llama3.2:1b' });
    const chunks = await collect(
      provider.chat({
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', description: 'get weather', parameters: {} }],
      }),
    );

    expect(chunks).toEqual([
      { type: 'tool_call', toolCall: { id: 'call_abc', name: 'get_weather', arguments: '{"city":"Blaine"}' } },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('yields an error chunk on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const provider = new OllamaProvider({ model: 'llama3.2:3b' });
    const chunks = await collect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(chunks).toEqual([{ type: 'error', message: 'ollama chat failed: 500' }]);
  });
});

describe('isOllamaServerUp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when /api/tags responds ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    expect(await isOllamaServerUp()).toBe(true);
  });

  it('is false when the request throws (server not running)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await isOllamaServerUp()).toBe(false);
  });
});

describe('listOllamaModelsDetailed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('converts byte sizes to rounded GB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:3b', size: 2_147_483_648 }, { name: 'no-size' }] }),
          { status: 200 },
        ),
      ),
    );
    expect(await listOllamaModelsDetailed()).toEqual([
      { name: 'llama3.2:3b', sizeGb: 2 },
      { name: 'no-size', sizeGb: 0 },
    ]);
  });
});
