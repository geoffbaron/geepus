import type { ChatMessage } from '@shared/model';

/** One-shot, non-streaming convenience wrapper over the streaming chat IPC. */
export function askOnce(prompt: string, systemPrompt?: string): Promise<string> {
  const messages: ChatMessage[] = systemPrompt
    ? [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: prompt }];

  return new Promise((resolve, reject) => {
    let text = '';
    const unsubscribe = window.geepus.models.chat({ messages }, (chunk) => {
      if (chunk.type === 'text') {
        text += chunk.delta;
      } else if (chunk.type === 'done') {
        unsubscribe();
        resolve(text);
      } else if (chunk.type === 'error') {
        unsubscribe();
        reject(new Error(chunk.message));
      }
    });
  });
}
