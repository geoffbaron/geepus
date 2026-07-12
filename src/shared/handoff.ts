/**
 * "Handoff" artifacts (PLAN2.md N1) — Geepus prepares these, the user's own default apps
 * finish them. Zero setup, works on any OS: no account, no password, ever touches Geepus.
 */

export interface EmailDraftCard {
  kind: 'email';
  to?: string;
  subject: string;
  body: string;
}

export interface EventCard {
  kind: 'event';
  title: string;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
  location?: string;
  notes?: string;
  /** Absolute path to the generated .ics file — opening it hands off to the OS's default calendar app. */
  icsPath: string;
}

export type HandoffCard = EmailDraftCard | EventCard;

export interface OpenMailDraftResult {
  opened: boolean;
  /** True when the body was too long for a mailto: URL and the full text was copied to the clipboard instead. */
  copiedToClipboard: boolean;
}

export interface OpenCalendarFileResult {
  opened: boolean;
  error?: string;
}
