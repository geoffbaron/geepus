import { describe, expect, it, vi, beforeEach } from 'vitest';

const connect = vi.fn();
const logout = vi.fn();
const close = vi.fn();
const getMailboxLock = vi.fn();
const search = vi.fn();
const fetch = vi.fn();
const release = vi.fn();

const { MockAuthenticationFailure } = vi.hoisted(() => {
  class MockAuthenticationFailure extends Error {
    authenticationFailed = true as const;
    response?: string;
    constructor(message: string, response?: string) {
      super(message);
      this.response = response;
    }
  }
  return { MockAuthenticationFailure };
});

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect,
    logout,
    close,
    getMailboxLock,
    search,
    fetch,
  })),
  AuthenticationFailure: MockAuthenticationFailure,
}));

vi.mock('mailparser', () => ({
  simpleParser: vi.fn().mockResolvedValue({ text: 'parsed body text' }),
}));

import { fetchUnreadEmails, testImapConnection, IMAP_PROVIDER_PRESETS } from './imap';

const config = { host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com', pass: 'app-password' };

describe('IMAP module structural read-only guarantee', () => {
  it('exports exactly the read-only surface — no send/mark/delete/move function exists at all', async () => {
    const moduleExports = await import('./imap');
    const names = Object.keys(moduleExports);
    expect(names).toEqual(
      expect.arrayContaining(['fetchUnreadEmails', 'testImapConnection', 'IMAP_PROVIDER_PRESETS']),
    );
    // Not a policy check, a structural one: these capabilities are never implemented,
    // so there is nothing to accidentally call, no matter what a caller intends.
    for (const forbidden of ['sendEmail', 'markSeen', 'markRead', 'deleteEmail', 'moveEmail', 'flagEmail', 'send', 'delete', 'move']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('fetchUnreadEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue(undefined);
    logout.mockResolvedValue(undefined);
    getMailboxLock.mockResolvedValue({ release });
    search.mockResolvedValue([101, 102]);
    fetch.mockImplementation(async function* () {
      yield {
        uid: 101,
        envelope: { from: [{ address: 'boss@work.com' }], subject: 'Urgent: server down', date: '2026-07-10T12:00:00Z' },
        source: Buffer.from('raw email'),
      };
      yield {
        uid: 102,
        envelope: { from: [{ address: 'newsletter@example.com' }], subject: 'Weekly digest', date: '2026-07-10T09:00:00Z' },
        source: Buffer.from('raw email'),
      };
    });
  });

  it('opens the mailbox in read-only mode — the server enforces this, not just app code', async () => {
    await fetchUnreadEmails(config);
    expect(getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
  });

  it('searches only for unseen messages', async () => {
    await fetchUnreadEmails(config);
    expect(search).toHaveBeenCalledWith({ seen: false }, { uid: true });
  });

  it('returns parsed summaries for each unread message', async () => {
    const results = await fetchUnreadEmails(config);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ uid: 101, from: 'boss@work.com', subject: 'Urgent: server down' });
    expect(results[0]?.snippet).toContain('parsed body text');
  });

  it('releases the mailbox lock and logs out even if fetch fails', async () => {
    fetch.mockImplementation(async function* () {
      throw new Error('connection reset');
    });
    await expect(fetchUnreadEmails(config)).rejects.toThrow('connection reset');
    expect(release).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
  });

  it('returns an empty array when there are no unread messages, without fetching', async () => {
    search.mockResolvedValue([]);
    const results = await fetchUnreadEmails(config);
    expect(results).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caps results at the requested limit, taking the most recent', async () => {
    search.mockResolvedValue([1, 2, 3, 4, 5]);
    await fetchUnreadEmails(config, 2);
    expect(fetch).toHaveBeenCalledWith([4, 5], expect.anything(), { uid: true });
  });
});

describe('testImapConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok:true on a successful connect+logout', async () => {
    connect.mockResolvedValue(undefined);
    logout.mockResolvedValue(undefined);
    const result = await testImapConnection(config);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with the error message on a generic connection failure, without throwing', async () => {
    connect.mockRejectedValue(new Error('Invalid credentials'));
    const result = await testImapConnection(config);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid credentials');
  });

  // Regression: a live test against a real Gmail server with wrong credentials showed that
  // imapflow's generic Error.message for an auth failure is just "Command failed" — useless
  // in a settings UI. AuthenticationFailure carries the server's actual response text, which
  // must be surfaced instead.
  it('regression: surfaces the server response text from an AuthenticationFailure, not the generic message', async () => {
    connect.mockRejectedValue(new MockAuthenticationFailure('Command failed', 'Invalid credentials (Failure)'));
    const result = await testImapConnection(config);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid credentials (Failure)');
    expect(result.error).not.toBe('Command failed');
  });

  it('falls back to a friendly message when AuthenticationFailure has no server response text', async () => {
    connect.mockRejectedValue(new MockAuthenticationFailure('Command failed'));
    const result = await testImapConnection(config);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/check your email address and app password/i);
  });

  it('never fetches any messages during a connection test', async () => {
    connect.mockResolvedValue(undefined);
    await testImapConnection(config);
    expect(getMailboxLock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('IMAP_PROVIDER_PRESETS', () => {
  it('has correct, real IMAP hosts for the major providers', () => {
    expect(IMAP_PROVIDER_PRESETS['gmail']?.host).toBe('imap.gmail.com');
    expect(IMAP_PROVIDER_PRESETS['icloud']?.host).toBe('imap.mail.me.com');
    expect(IMAP_PROVIDER_PRESETS['outlook']?.host).toBe('outlook.office365.com');
  });
});
