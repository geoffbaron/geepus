/** Shared chat/model types used across main, preload, and renderer. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on role:"tool" messages — which tool call this is a result for. */
  toolCallId?: string;
  /** Present on role:"assistant" messages that requested tool calls. */
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'length' | 'error' }
  | { type: 'error'; message: string };

export type ProviderId = 'ollama' | 'bundled' | 'openrouter';

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
  detail?: string;
}

export type RamTier = 'minimal' | 'basic' | 'good' | 'great' | 'monster';

export interface ModelCatalogEntry {
  /** Ollama library tag, e.g. "llama3.2:3b". */
  ollamaTag: string;
  family: string;
  paramsB: number;
  quant: string;
  sizeGb: number;
  minRamGb: number;
  tier: RamTier;
  /** True for embedding-only models — never offered as the chat model. */
  embedding?: boolean;
}

export interface OllamaPullProgress {
  model: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  done: boolean;
}
