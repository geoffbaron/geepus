import type { ScheduledTask } from '@shared/schedule';
import type { DailyBrief } from '@shared/brief';
import type { InboxRunResult } from '@shared/mail';
import type { Suggestion } from './suggest';

export type { DailyBrief };

export interface DailyBriefInput {
  inbox?: InboxRunResult;
  upcomingTasks: ScheduledTask[];
  suggestions: Suggestion[];
  weatherSummary?: string | null;
}

/** Composes the daily brief from whatever sections are available — every section is
 * optional so a partial brief (e.g. no IMAP configured yet) still renders (PLAN.md §7 item 3). */
export function composeDailyBrief(input: DailyBriefInput): DailyBrief {
  const lines: string[] = [`# Daily Brief — ${new Date().toLocaleDateString()}`];

  if (input.weatherSummary) {
    lines.push('', '## Weather', input.weatherSummary);
  }

  if (input.inbox) {
    lines.push('', '## Inbox', `${input.inbox.totalUnread} unread, ${input.inbox.urgentCount} urgent.`);
    const urgent = input.inbox.summaries.filter((e) => e.urgency === 'urgent');
    if (urgent.length > 0) {
      lines.push(...urgent.map((e) => `- ⚠️ ${e.from}: ${e.subject}`));
    }
  }

  if (input.upcomingTasks.length > 0) {
    lines.push('', '## Upcoming', ...input.upcomingTasks.slice(0, 5).map((t) => `- ${t.name} (${t.schedule})`));
  }

  if (input.suggestions.length > 0) {
    lines.push('', '## Suggestions', ...input.suggestions.map((s) => `- ${s.text}`));
  }

  return { generatedAt: new Date().toISOString(), text: lines.join('\n') };
}

/** One allowlisted HTTP source (PLAN.md §7 item 3, and already on the http_get tool's
 * allowlist in policy/rules.ts) — no API key needed. */
export async function fetchWeatherSummary(latitude: number, longitude: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { current?: { temperature_2m?: number } };
    const temp = data.current?.temperature_2m;
    return typeof temp === 'number' ? `${temp}°C currently.` : null;
  } catch {
    return null;
  }
}
