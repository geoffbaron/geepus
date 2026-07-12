import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailDraftCard, EventCard } from '@shared/handoff';
import { draftEmailTool, proposeEventTool } from './handoff';

const ctx = { workspaceRoot: '/tmp/ws' };
const generatedFiles: string[] = [];

afterEach(async () => {
  await Promise.all(generatedFiles.splice(0).map((f) => rm(f, { force: true })));
});

describe('draftEmailTool', () => {
  it('produces an email card with the given fields', async () => {
    const result = await draftEmailTool.execute({ to: 'landlord@example.com', subject: 'Leak', body: 'The kitchen sink is leaking.' }, ctx);
    expect(result.ok).toBe(true);
    const card = JSON.parse(result.output!) as EmailDraftCard;
    expect(card).toEqual({ kind: 'email', to: 'landlord@example.com', subject: 'Leak', body: 'The kitchen sink is leaking.' });
  });

  it('omits `to` entirely when no recipient is given, rather than an empty string', async () => {
    const result = await draftEmailTool.execute({ subject: 'Hi', body: 'Just checking in.' }, ctx);
    const card = JSON.parse(result.output!) as EmailDraftCard;
    expect(card.to).toBeUndefined();
  });

  it('fails when both subject and body are empty', async () => {
    const result = await draftEmailTool.execute({ subject: '', body: '' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('is always write-tier, never sensitive — drafting is not sending', () => {
    expect(draftEmailTool.riskTier({}, ctx)).toBe('write');
  });
});

describe('proposeEventTool', () => {
  it('generates a real .ics file with correct UTC-converted times and RFC 5545 structure', async () => {
    const result = await proposeEventTool.execute(
      { title: 'Dentist', startsAt: '2026-07-14T14:00:00', endsAt: '2026-07-14T15:00:00', location: '123 Main St', notes: 'Bring insurance card' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const card = JSON.parse(result.output!) as EventCard;
    generatedFiles.push(card.icsPath);

    const ics = await readFile(card.icsPath, 'utf8');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Dentist');
    expect(ics).toContain('LOCATION:123 Main St');
    expect(ics).toContain('DESCRIPTION:Bring insurance card');
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');

    // The DTSTART must be the correct UTC instant for the local time given, not a raw copy.
    const expectedUtc = new Date('2026-07-14T14:00:00').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    expect(ics).toContain(`DTSTART:${expectedUtc}`);
  });

  it('defaults endsAt to one hour after startsAt when omitted', async () => {
    const result = await proposeEventTool.execute({ title: 'Quick call', startsAt: '2026-07-14T09:00:00' }, ctx);
    const card = JSON.parse(result.output!) as EventCard;
    generatedFiles.push(card.icsPath);
    expect(new Date(card.endsAt).getTime() - new Date(card.startsAt).getTime()).toBe(60 * 60_000);
  });

  it('escapes commas, semicolons, and newlines in free-text fields (RFC 5545 §3.3.11)', async () => {
    const result = await proposeEventTool.execute(
      { title: 'Team sync, Q3 planning; retro', startsAt: '2026-07-14T09:00:00', notes: 'Line one\nLine two' },
      ctx,
    );
    const card = JSON.parse(result.output!) as EventCard;
    generatedFiles.push(card.icsPath);
    const ics = await readFile(card.icsPath, 'utf8');
    expect(ics).toContain('SUMMARY:Team sync\\, Q3 planning\\; retro');
    expect(ics).toContain('DESCRIPTION:Line one\\nLine two');
  });

  it('fails on an unparseable start time instead of silently producing an Invalid Date file', async () => {
    const result = await proposeEventTool.execute({ title: 'Whenever', startsAt: 'not a real date' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('is always write-tier — the event still needs the user to confirm in their own calendar app', () => {
    expect(proposeEventTool.riskTier({}, ctx)).toBe('write');
  });
});
