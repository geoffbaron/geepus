import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailDraftCard, EventCard } from '@shared/handoff';
import type { ToolHandler } from './types';

/**
 * "Handoff" tools (PLAN2.md N1): Geepus prepares an artifact, the user's own default mail
 * or calendar app finishes it. No account, no password, ever touches Geepus — this is the
 * zero-setup channel that works identically on any OS. Structurally can't send anything:
 * there is no send_email tool, only draft_email, same discipline as v1's read-only IMAP
 * module having no delete/send function at all.
 */

export const draftEmailTool: ToolHandler = {
  definition: {
    name: 'draft_email',
    description:
      "Draft an email for the user to review and send themselves — Geepus never sends email directly. " +
      'The user will see the draft and choose to open it in their own mail app.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Recipient's email address, if known." },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subject', 'body'],
    },
  },
  riskTier: () => 'write',
  summarize: (args) => `Draft email: ${String(args['subject'] ?? '')}`,
  execute: async (args) => {
    const subject = String(args['subject'] ?? '').trim();
    const body = String(args['body'] ?? '').trim();
    if (!subject && !body) {
      return { tool: 'draft_email', ok: false, summary: 'Nothing to draft — subject and body are both empty.' };
    }
    const to = typeof args['to'] === 'string' ? args['to'].trim() : undefined;
    const card: EmailDraftCard = { kind: 'email', to: to || undefined, subject, body };
    return { tool: 'draft_email', ok: true, summary: `Drafted email: ${subject || '(no subject)'}`, output: JSON.stringify(card) };
  },
};

/** RFC 5545 §3.3.11 TEXT escaping — backslash, comma, semicolon, and newline are structural. */
function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r?\n/g, '\\n');
}

/** UTC "floating" form (YYYYMMDDTHHMMSSZ) — every calendar app converts this to the
 * viewer's local display timezone on import, so no VTIMEZONE block is needed. */
function toIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildIcs(event: { title: string; startsAt: Date; endsAt: Date; location?: string; notes?: string }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Geepus//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${randomUUID()}@geepus.local`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(event.startsAt)}`,
    `DTEND:${toIcsUtc(event.endsAt)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeIcsText(event.notes)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

const DEFAULT_DURATION_MS = 60 * 60_000;

export const proposeEventTool: ToolHandler = {
  definition: {
    name: 'propose_event',
    description:
      'Propose a calendar event for the user to review and add themselves — Geepus never touches the user\'s ' +
      "calendar directly. Generates a calendar file the user's own default calendar app opens to confirm. " +
      'startsAt/endsAt are ISO 8601 local date-times, e.g. "2026-07-14T14:00:00".',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startsAt: { type: 'string', description: 'ISO 8601 local date-time.' },
        endsAt: { type: 'string', description: 'ISO 8601 local date-time. Defaults to one hour after startsAt.' },
        location: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title', 'startsAt'],
    },
  },
  riskTier: () => 'write',
  summarize: (args) => `Propose event: ${String(args['title'] ?? '')} at ${String(args['startsAt'] ?? '')}`,
  execute: async (args) => {
    const title = String(args['title'] ?? '').trim();
    const startsAtRaw = String(args['startsAt'] ?? '').trim();
    if (!title || !startsAtRaw) {
      return { tool: 'propose_event', ok: false, summary: 'Missing title or start time.' };
    }
    const startsAt = new Date(startsAtRaw);
    if (Number.isNaN(startsAt.getTime())) {
      return { tool: 'propose_event', ok: false, summary: `Could not understand the start time: "${startsAtRaw}"` };
    }
    const endsAtRaw = typeof args['endsAt'] === 'string' ? args['endsAt'].trim() : '';
    const endsAt = endsAtRaw ? new Date(endsAtRaw) : new Date(startsAt.getTime() + DEFAULT_DURATION_MS);
    if (Number.isNaN(endsAt.getTime())) {
      return { tool: 'propose_event', ok: false, summary: `Could not understand the end time: "${endsAtRaw}"` };
    }
    const location = typeof args['location'] === 'string' ? args['location'].trim() : undefined;
    const notes = typeof args['notes'] === 'string' ? args['notes'].trim() : undefined;

    const icsPath = join(tmpdir(), `geepus-event-${Date.now()}-${randomUUID().slice(0, 8)}.ics`);
    await writeFile(icsPath, buildIcs({ title, startsAt, endsAt, location, notes }), 'utf8');

    const card: EventCard = {
      kind: 'event',
      title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      location: location || undefined,
      notes: notes || undefined,
      icsPath,
    };
    return { tool: 'propose_event', ok: true, summary: `Proposed event: ${title}`, output: JSON.stringify(card) };
  },
};

export const HANDOFF_TOOLS: ToolHandler[] = [draftEmailTool, proposeEventTool];
