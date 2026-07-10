import type { ChatChunk, ChatRequest, ProviderId, ToolCall } from '@shared/model';
import type { ModelProvider } from './provider';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Dev/testing-only provider — never surfaced to the friend-facing onboarding wizard.
 * See PLAN.md §3: Geoff's own machine can't run the larger local models, so this is
 * what exercises full agent behavior during development. Gated by Settings → Developer
 * options (or GEEPUS_DEV_PROVIDER=openrouter for headless dev use).
 */
export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function toOpenAiMessages(request: ChatRequest) {
  return request.messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTools(request: ChatRequest) {
  if (!request.tools?.length) return undefined;
  return request.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OpenRouterProvider implements ModelProvider {
  readonly id: ProviderId = 'openrouter';
  private readonly config: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey);
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: toOpenAiMessages(request),
        tools: toOpenAiTools(request),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      yield { type: 'error', message: `openrouter chat failed: ${res.status} ${await safeText(res)}` };
      return;
    }

    const pendingCalls = new Map<number, PendingToolCall>();
    let finishReason: string | undefined;

    for await (const event of readSse(res.body)) {
      if (event === '[DONE]') break;
      const parsed = JSON.parse(event) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
      };
      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { type: 'text', delta: choice.delta.content };
      }
      for (const callDelta of choice.delta?.tool_calls ?? []) {
        const existing = pendingCalls.get(callDelta.index) ?? { id: '', name: '', arguments: '' };
        if (callDelta.id) existing.id = callDelta.id;
        if (callDelta.function?.name) existing.name += callDelta.function.name;
        if (callDelta.function?.arguments) existing.arguments += callDelta.function.arguments;
        pendingCalls.set(callDelta.index, existing);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    for (const call of pendingCalls.values()) {
      const toolCall: ToolCall = {
        id: call.id || `call_${Math.random().toString(36).slice(2)}`,
        name: call.name,
        arguments: call.arguments || '{}',
      };
      yield { type: 'tool_call', toolCall };
    }

    yield {
      type: 'done',
      finishReason: pendingCalls.size > 0 ? 'tool_calls' : finishReason === 'length' ? 'length' : 'stop',
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
}
