/// <reference lib="dom" />
// The reference above pulls in DOM types (document, HTMLElement) for type-checking ONLY
// this file's page.evaluate() closures, which execute inside the browser page, not in
// Node — tsconfig.node.json deliberately omits the DOM lib for every other main-process
// file, so this stays file-scoped rather than changing that project-wide.
import type { Page } from '../session';
import type { EmailSummary } from '@shared/mail';

/**
 * Gmail-specific pieces of the webmail connect flow: where to send the user to sign in,
 * how to tell whether the Geepus Browser profile is already signed in, and how to read
 * unread mail out of the real, logged-in inbox — all via semantic/structural DOM queries,
 * never numeric IDs (PLAN.md §7 item 5), consistent with the rest of the browser stack.
 */

export const GMAIL_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/';
export const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';

/** True once the profile lands on mail.google.com instead of being redirected to the
 * accounts.google.com sign-in flow. Purely URL-based — no DOM dependency, so it can't
 * break from a Gmail UI redesign. */
export function isGmailUrlSignedIn(url: string): boolean {
  return /^https:\/\/mail\.google\.com\//.test(url);
}

/**
 * Extracts unread-message summaries from Gmail's inbox. Targets Gmail's long-standing
 * accessibility affordances rather than its obfuscated CSS classes (those regenerate on
 * every Gmail deploy): each message row carries `role="row"`, and the sender element
 * carries a real `email` attribute (a stable, long-documented Gmail DOM feature many
 * screen readers and extensions already depend on) — both survive UI refreshes far better
 * than class names. Unread rows are bold in Gmail's UI; the row's `aria-label` typically
 * starts wtih the word "Unread" for unread messages, screen-reader text that is exactly
 * the semantic signal Playwright should read here instead of guessing from font-weight.
 */
interface RawGmailRow {
  from: string;
  subject: string;
  snippet: string;
}

export async function readGmailUnread(page: Page, limit = 20): Promise<EmailSummary[]> {
  const rows = await page.evaluate((maxRows: number): RawGmailRow[] => {
    const allRows = Array.from(document.querySelectorAll<HTMLElement>('tr[role="row"]'));
    const results: RawGmailRow[] = [];

    for (const row of allRows) {
      if (results.length >= maxRows) break;
      const ariaLabel = row.getAttribute('aria-label') ?? '';
      // Gmail prefixes unread rows' aria-label with "Unread" for screen readers — the
      // most stable "is this unread" signal available, since bold-font CSS classes churn.
      if (!/^unread/i.test(ariaLabel.trim())) continue;

      const senderEl = row.querySelector<HTMLElement>('[email]');
      // `from` is the address (what memory/urgency-classification/display actually want);
      // `senderName` is the *display name* Gmail puts in the aria-label — they're different
      // strings ("Alice Smith" vs "alice@example.com"), so stripping the label's leading
      // sender segment must match against the name, not the email address it's paired with.
      const from = senderEl?.getAttribute('email') ?? senderEl?.textContent?.trim() ?? 'unknown';
      const senderName = senderEl?.textContent?.trim() || from;

      // Strip the leading "Unread, <sender name>, " prefix Gmail puts on the aria-label so
      // what's left is the subject + snippet, which Gmail otherwise renders in
      // deploy-specific CSS classes not safe to depend on.
      const escapedName = senderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rest = ariaLabel.replace(/^unread,?\s*/i, '').replace(new RegExp(`^${escapedName},?\\s*`, 'i'), '');
      const [subject = '(no subject)', ...snippetParts] = rest.split(',').map((s) => s.trim());

      results.push({ from, subject, snippet: snippetParts.join(', ').slice(0, 500) });
    }
    return results;
  }, limit);

  // Gmail's real message ids are opaque strings, not the numeric uid IMAP uses — a
  // synthetic sequential id is fine since nothing downstream (brief composition, urgency
  // classification) keys off uid for anything beyond display-order identity.
  return rows.map((row, index) => ({ uid: index, from: row.from, subject: row.subject, snippet: row.snippet, date: '' }));
}
