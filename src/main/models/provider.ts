import type { ChatChunk, ChatRequest, ProviderId } from '@shared/model';

export interface ModelProvider {
  readonly id: ProviderId;
  isAvailable(): Promise<boolean>;
  chat(request: ChatRequest): AsyncGenerator<ChatChunk>;
}
