import type { ImapAccountConfig } from '../mail/imap';
import { fetchUnreadEmails } from '../mail/imap';
import type { MemoryService } from '../memory/service';
import type { ClassifiedEmail, EmailSummary, EmailUrgency, InboxRunResult } from '@shared/mail';

export type { ClassifiedEmail, EmailUrgency, EmailSummary, InboxRunResult };

const URGENT_PATTERNS = [/\burgent\b/i, /\basap\b/i, /\bemergency\b/i, /\bcritical\b/i, /\b(server|site|prod(uction)?) (is )?down\b/i, /\boutage\b/i, /\bdeadline (today|tomorrow)\b/i];
const JUNK_PATTERNS = [/\bunsubscribe\b/i, /\bnewsletter\b/i, /\bpromo(tion)?\b/i, /\d+% off\b/i, /\bsale ends\b/i];
const NEEDS_REPLY_PATTERNS = [/\?\s*$/, /\bplease (let me know|confirm|advise|respond)\b/i, /\bcould you\b/i, /\bcan you\b/i, /\bwaiting (for|on) your\b/i];

/** Deterministic keyword classifier — same "pure code, not AI" philosophy as the task
 * classifier (classify.ts). Priority: urgent > junk > needs-reply > fyi (default). */
export function classifyEmailUrgency(email: Pick<EmailSummary, 'subject' | 'snippet' | 'from'>): EmailUrgency {
  const text = `${email.subject} ${email.snippet}`;
  if (URGENT_PATTERNS.some((p) => p.test(text))) return 'urgent';
  if (JUNK_PATTERNS.some((p) => p.test(text)) || JUNK_PATTERNS.some((p) => p.test(email.from))) return 'junk';
  if (NEEDS_REPLY_PATTERNS.some((p) => p.test(text))) return 'needs-reply';
  return 'fyi';
}

/** Classifies an already-fetched batch of emails and records the summary in memory — the
 * source-agnostic half of the inbox agent, shared by both the IMAP path (below) and the
 * webmail/browser-session path (agents/webmailInbox.ts) so this logic lives in one place. */
export async function classifyAndRecordInbox(emails: EmailSummary[], memory: MemoryService): Promise<InboxRunResult> {
  const summaries: ClassifiedEmail[] = emails.map((email) => ({ ...email, urgency: classifyEmailUrgency(email) }));
  const urgentCount = summaries.filter((e) => e.urgency === 'urgent').length;

  if (summaries.length > 0) {
    const summaryText = summaries
      .map((e) => `[${e.urgency}] ${e.from}: ${e.subject} — ${e.snippet.slice(0, 150)}`)
      .join('\n');
    await memory.remember(`Inbox summary (${new Date().toISOString()}):\n${summaryText}`);
  }

  return { totalUnread: summaries.length, urgentCount, summaries };
}

export interface RunInboxAgentOptions {
  imapConfig: ImapAccountConfig;
  memory: MemoryService;
  limit?: number;
}

/**
 * Fetches unread mail (read-only, via imap.ts), classifies urgency, and stores a summary
 * in memory. Never sends, marks, or moves anything — that capability doesn't exist in
 * imap.ts at all (PLAN.md §7 item 2).
 */
export async function runInboxAgent(options: RunInboxAgentOptions): Promise<InboxRunResult> {
  const emails = await fetchUnreadEmails(options.imapConfig, options.limit ?? 20);
  return classifyAndRecordInbox(emails, options.memory);
}
