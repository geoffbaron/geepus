import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebmailInboxAgent } from './webmailInbox';

vi.mock('../browser/webmailSession', () => ({
  readWebmailUnread: vi.fn(),
}));

describe('runWebmailInboxAgent', () => {
  const memory = { remember: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('reads from the webmail session and produces the same InboxRunResult shape as the IMAP path', async () => {
    const { readWebmailUnread } = await import('../browser/webmailSession');
    vi.mocked(readWebmailUnread).mockResolvedValue([
      { uid: 0, from: 'ops@work.com', subject: 'URGENT: prod is down', date: '', snippet: 'asap' },
      { uid: 1, from: 'newsletter@blog.com', subject: 'Weekly digest', date: '', snippet: 'unsubscribe' },
    ]);

    const result = await runWebmailInboxAgent({ provider: 'gmail', memory: memory as never });
    expect(result.totalUnread).toBe(2);
    expect(result.urgentCount).toBe(1);
    expect(result.summaries[0]?.urgency).toBe('urgent');
    expect(memory.remember).toHaveBeenCalledOnce();
  });

  it('passes the provider and limit through to readWebmailUnread', async () => {
    const { readWebmailUnread } = await import('../browser/webmailSession');
    vi.mocked(readWebmailUnread).mockResolvedValue([]);

    await runWebmailInboxAgent({ provider: 'gmail', memory: memory as never, limit: 5 });
    expect(readWebmailUnread).toHaveBeenCalledWith('gmail', 5);
  });

  it('does not touch memory when the inbox is empty', async () => {
    const { readWebmailUnread } = await import('../browser/webmailSession');
    vi.mocked(readWebmailUnread).mockResolvedValue([]);

    const result = await runWebmailInboxAgent({ provider: 'gmail', memory: memory as never });
    expect(result.totalUnread).toBe(0);
    expect(memory.remember).not.toHaveBeenCalled();
  });
});
