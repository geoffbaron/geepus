import { app } from 'electron';
import { join } from 'node:path';
import { MemoryService } from './service';

let instance: MemoryService | null = null;

/** One MemoryService per process, backed by userData/memory — shared by the runtime
 * loop and the memory IPC/browser UI so they see the same data. */
export function getMemoryService(ollamaBaseUrl?: string): MemoryService {
  if (!instance) {
    instance = new MemoryService({
      dataDir: join(app.getPath('userData'), 'memory'),
      embeddingConfig: { ollamaBaseUrl, ollamaModel: 'nomic-embed-text' },
    });
  }
  return instance;
}
