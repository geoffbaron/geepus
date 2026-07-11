import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailSummary, ImapConnectionTestResult, MailAccountInput } from '@shared/mail';

export type ImapAccountConfig = MailAccountInput;
export type { EmailSummary, ImapConnectionTestResult };

function createClient(config: ImapAccountConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
}

/**
 * Read-only, structurally — not just by convention. The mailbox is opened with
 * `readOnly: true`, which the IMAP server itself enforces: no \Seen flag ever gets set
 * by fetching a message, and no STORE/EXPUNGE/MOVE command could succeed even if this
 * code tried to issue one (it never does — there is no send/mark/delete/move function
 * anywhere in this module). PLAN.md §7 item 2 / §9: the Inbox agent must never modify mail.
 */
export async function fetchUnreadEmails(config: ImapAccountConfig, limit = 20): Promise<EmailSummary[]> {
  const client = createClient(config);
  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const targetUids = uids.slice(-limit);
      const results: EmailSummary[] = [];

      for await (const message of client.fetch(targetUids, { envelope: true, source: true }, { uid: true })) {
        const parsed = message.source ? await simpleParser(message.source) : null;
        const fromAddress = message.envelope?.from?.[0]?.address ?? message.envelope?.from?.[0]?.name ?? 'unknown';
        results.push({
          uid: message.uid,
          from: fromAddress,
          subject: message.envelope?.subject ?? '(no subject)',
          date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : '',
          snippet: (parsed?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
        });
      }
      return results;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

interface ImapAuthenticationError extends Error {
  authenticationFailed: true;
  response?: string;
}

function isAuthenticationFailure(err: unknown): err is ImapAuthenticationError {
  return err instanceof Error && (err as { authenticationFailed?: unknown }).authenticationFailed === true;
}

/**
 * A real live test against Gmail with wrong credentials showed the generic Error.message
 * is just "Command failed" — useless in a settings UI. imapflow's own auth-failure error
 * carries the server's actual response text (e.g. "Invalid credentials"), which is what the
 * user needs to see — but that error class (AuthenticationFailure) turned out to be a real
 * upstream bug: imapflow's .d.ts declares it as a package export, but the actual runtime
 * entry point (lib/imap-flow.js) never re-exports it — only ImapFlow. `instanceof
 * AuthenticationFailure` therefore throws at runtime ("Right-hand side of 'instanceof' is
 * not an object") even though it type-checks fine. Duck-typing on the `authenticationFailed`
 * marker property (which the real error objects do carry) sidesteps the broken export.
 */
function describeConnectionError(err: unknown): string {
  if (isAuthenticationFailure(err)) {
    return err.response?.trim() || 'Authentication failed — check your email address and app password.';
  }
  return (err as Error).message;
}

export async function testImapConnection(config: ImapAccountConfig): Promise<ImapConnectionTestResult> {
  const client = createClient(config);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeConnectionError(err) };
  }
}

/** Well-known providers' IMAP settings, for the onboarding UI's app-password walkthrough. */
export const IMAP_PROVIDER_PRESETS: Record<string, { host: string; port: number; secure: boolean; appPasswordUrl: string }> = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, appPasswordUrl: 'https://myaccount.google.com/apppasswords' },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, appPasswordUrl: 'https://appleid.apple.com/account/manage' },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, appPasswordUrl: 'https://account.live.com/proofs/AppPassword' },
  fastmail: { host: 'imap.fastmail.com', port: 993, secure: true, appPasswordUrl: 'https://www.fastmail.com/settings/security/apppasswords' },
};
