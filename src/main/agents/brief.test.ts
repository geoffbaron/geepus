import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeDailyBrief, fetchWeatherSummary } from './brief';
import type { ScheduledTask } from '@shared/schedule';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: 'Inbox check',
    objective: 'check inbox',
    schedule: 'every 30m',
    workspaceRoot: '',
    loopMode: false,
    loopDelaySeconds: 0,
    maxConsecutiveFailures: 3,
    enabled: true,
    lastRunAt: null,
    lastRunState: '',
    loopConsecutiveFailures: 0,
    loopTotalRuns: 0,
    nextRunAt: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('composeDailyBrief', () => {
  it('renders all sections when everything is available', () => {
    const brief = composeDailyBrief({
      inbox: { totalUnread: 3, urgentCount: 1, summaries: [{ uid: 1, from: 'a@b.com', subject: 'Urgent thing', date: '', snippet: '', urgency: 'urgent' }] },
      upcomingTasks: [task()],
      suggestions: [{ text: 'Retry: sync calendar', objective: 'sync calendar' }],
      weatherSummary: '18°C currently.',
    });
    expect(brief.text).toContain('Weather');
    expect(brief.text).toContain('18°C');
    expect(brief.text).toContain('Inbox');
    expect(brief.text).toContain('3 unread, 1 urgent');
    expect(brief.text).toContain('Urgent thing');
    expect(brief.text).toContain('Upcoming');
    expect(brief.text).toContain('Inbox check');
    expect(brief.text).toContain('Suggestions');
    expect(brief.text).toContain('sync calendar');
  });

  it('renders gracefully with no sections at all (nothing configured yet)', () => {
    const brief = composeDailyBrief({ upcomingTasks: [], suggestions: [] });
    expect(brief.text).toContain('Daily Brief');
    expect(brief.text).not.toContain('Inbox');
    expect(brief.text).not.toContain('Weather');
  });

  it('only lists urgent emails in the inbox section, not all unread', () => {
    const brief = composeDailyBrief({
      inbox: {
        totalUnread: 2,
        urgentCount: 1,
        summaries: [
          { uid: 1, from: 'a@b.com', subject: 'Urgent one', date: '', snippet: '', urgency: 'urgent' },
          { uid: 2, from: 'c@d.com', subject: 'FYI notice', date: '', snippet: '', urgency: 'fyi' },
        ],
      },
      upcomingTasks: [],
      suggestions: [],
    });
    expect(brief.text).toContain('Urgent one');
    expect(brief.text).not.toContain('FYI notice');
  });

  it('caps the upcoming tasks section at 5', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, name: `Task ${i}` }));
    const brief = composeDailyBrief({ upcomingTasks: tasks, suggestions: [] });
    expect(brief.text).toContain('Task 0');
    expect(brief.text).not.toContain('Task 7');
  });
});

describe('fetchWeatherSummary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('formats the current temperature on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ current: { temperature_2m: 22.2 } }), { status: 200 })),
    );
    expect(await fetchWeatherSummary(48.99, -122.75)).toBe('22.2°C currently.');
  });

  it('returns null on a failed request instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchWeatherSummary(0, 0)).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    expect(await fetchWeatherSummary(0, 0)).toBeNull();
  });
});
