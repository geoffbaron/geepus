import type { WebmailProviderId } from '@shared/webmail';
import type { InboxRunResult } from '@shared/mail';
import type { MemoryService } from '../memory/service';
import { readWebmailUnread } from '../browser/webmailSession';
import { classifyAndRecordInbox } from './inbox';

export interface RunWebmailInboxAgentOptions {
  provider: WebmailProviderId;
  memory: MemoryService;
  limit?: number;
}

/** The Geepus Browser equivalent of runInboxAgent (inbox.ts) — reads unread mail from the
 * signed-in webmail session instead of IMAP, then shares the exact same classify + memory
 * + InboxRunResult path so brief.ts and the renderer don't need to know which source ran. */
export async function runWebmailInboxAgent(options: RunWebmailInboxAgentOptions): Promise<InboxRunResult> {
  const emails = await readWebmailUnread(options.provider, options.limit ?? 20);
  return classifyAndRecordInbox(emails, options.memory);
}
