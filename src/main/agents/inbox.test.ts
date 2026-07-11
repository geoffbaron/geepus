import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyEmailUrgency, runInboxAgent } from './inbox';

vi.mock('../mail/imap', () => ({
  fetchUnreadEmails: vi.fn(),
}));

describe('classifyEmailUrgency', () => {
  it.each([
    { subject: 'URGENT: production is down', snippet: 'need help asap', from: 'ops@work.com' },
    { subject: 'Server outage', snippet: 'critical issue', from: 'alerts@work.com' },
  ])('classifies as urgent: %o', (email) => {
    expect(classifyEmailUrgency(email)).toBe('urgent');
  });

  it.each([
    { subject: '50% off everything this weekend!', snippet: 'unsubscribe here', from: 'deals@shop.com' },
    { subject: 'Weekly Newsletter', snippet: 'here is our roundup', from: 'newsletter@blog.com' },
  ])('classifies as junk: %o', (email) => {
    expect(classifyEmailUrgency(email)).toBe('junk');
  });

  it.each([
    { subject: 'Can you review this PR?', snippet: 'let me know your thoughts', from: 'colleague@work.com' },
    { subject: 'Quick question', snippet: 'could you confirm the meeting time?', from: 'partner@work.com' },
  ])('classifies as needs-reply: %o', (email) => {
    expect(classifyEmailUrgency(email)).toBe('needs-reply');
  });

  it('classifies a plain informational email as fyi (the default)', () => {
    expect(classifyEmailUrgency({ subject: 'Your receipt', snippet: 'thanks for your purchase', from: 'billing@store.com' })).toBe(
      'fyi',
    );
  });

  it('urgent takes priority over needs-reply when both signals are present', () => {
    expect(classifyEmailUrgency({ subject: 'URGENT: can you help asap?', snippet: '', from: 'boss@work.com' })).toBe('urgent');
  });
});

describe('runInboxAgent', () => {
  const config = { host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com', pass: 'x' };
  const memory = { remember: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('classifies each fetched email and counts urgent ones', async () => {
    const { fetchUnreadEmails } = await import('../mail/imap');
    vi.mocked(fetchUnreadEmails).mockResolvedValue([
      { uid: 1, from: 'ops@work.com', subject: 'URGENT: prod is down', date: '', snippet: 'asap' },
      { uid: 2, from: 'newsletter@blog.com', subject: 'Weekly digest', date: '', snippet: 'unsubscribe' },
    ]);

    const result = await runInboxAgent({ imapConfig: config, memory: memory as never });
    expect(result.totalUnread).toBe(2);
    expect(result.urgentCount).toBe(1);
    expect(result.summaries[0]?.urgency).toBe('urgent');
    expect(result.summaries[1]?.urgency).toBe('junk');
  });

  it('stores a summary in memory when there is unread mail', async () => {
    const { fetchUnreadEmails } = await import('../mail/imap');
    vi.mocked(fetchUnreadEmails).mockResolvedValue([{ uid: 1, from: 'a@b.com', subject: 'Hi', date: '', snippet: 'hello' }]);

    await runInboxAgent({ imapConfig: config, memory: memory as never });
    expect(memory.remember).toHaveBeenCalledOnce();
    expect(memory.remember.mock.calls[0]?.[0]).toContain('Hi');
  });

  it('does not touch memory when the inbox is empty', async () => {
    const { fetchUnreadEmails } = await import('../mail/imap');
    vi.mocked(fetchUnreadEmails).mockResolvedValue([]);

    const result = await runInboxAgent({ imapConfig: config, memory: memory as never });
    expect(result.totalUnread).toBe(0);
    expect(memory.remember).not.toHaveBeenCalled();
  });
});
