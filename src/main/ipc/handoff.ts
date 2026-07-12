import { clipboard, ipcMain, shell } from 'electron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCalendarFileResult, OpenMailDraftResult } from '@shared/handoff';

/**
 * shell.openPath can launch anything the OS knows how to open — a raw path from the
 * renderer is too much trust to extend for an arbitrary file. Only the exact .ics files
 * propose_event generates (src/main/tools/handoff.ts) are openable; this ordinary-looking
 * request never becomes "open any file on disk" even if the renderer were compromised.
 */
export function isGeepusEventFile(path: string): boolean {
  const normalized = join(path);
  return normalized.startsWith(join(tmpdir())) && /^geepus-event-\d+-[a-f0-9]{8}\.ics$/.test(normalized.split(/[/\\]/).pop() ?? '');
}

/** Most mail clients truncate or choke on very long mailto: bodies — keep the URL body
 * short and reliable, and give the user the full text on the clipboard to paste instead. */
const MAILTO_BODY_LIMIT = 1500;

/**
 * RFC 6068 mailto: query components need plain percent-encoding (space -> %20), NOT
 * application/x-www-form-urlencoded (space -> +) — found live: URLSearchParams.toString()
 * uses the latter, so Apple Mail rendered the draft with literal "+" characters instead of
 * spaces ("Kitchen+sink+leak"). encodeURIComponent is the correct encoder here.
 */
export function buildMailtoUrl(to: string | undefined, subject: string, body: string): string {
  const params: string[] = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  const query = params.join('&');
  const target = to ? encodeURIComponent(to) : '';
  return query ? `mailto:${target}?${query}` : `mailto:${target}`;
}

export function registerHandoffIpc(): void {
  ipcMain.handle(
    'handoff.openMailDraft',
    async (_event, draft: { to?: string; subject: string; body: string }): Promise<OpenMailDraftResult> => {
      const bodyTooLong = draft.body.length > MAILTO_BODY_LIMIT;
      const mailtoBody = bodyTooLong
        ? "I've copied the full draft to your clipboard — paste it here with Cmd/Ctrl-V."
        : draft.body;

      if (bodyTooLong) clipboard.writeText(draft.body);

      await shell.openExternal(buildMailtoUrl(draft.to, draft.subject, mailtoBody));
      return { opened: true, copiedToClipboard: bodyTooLong };
    },
  );

  ipcMain.handle('handoff.openCalendarFile', async (_event, path: string): Promise<OpenCalendarFileResult> => {
    if (!isGeepusEventFile(path)) {
      return { opened: false, error: 'Refusing to open a file Geepus did not generate.' };
    }
    const error = await shell.openPath(path);
    return error ? { opened: false, error } : { opened: true };
  });
}
