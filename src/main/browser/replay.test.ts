import { describe, expect, it, vi } from 'vitest';
import { replayControllerSpec } from './replay';
import type { BrowserControllerSpec } from '@shared/browser';
import type { BrowserSession } from './session';

function spec(steps: BrowserControllerSpec['playbook']['steps']): BrowserControllerSpec {
  return {
    version: 1,
    id: 'test-spec',
    name: 'Test spec',
    match: { domains: ['example.com'], intents: [] },
    route: { preferredEntryUrls: ['https://example.com'], fallbackEntryUrls: [], linkTextPriority: [] },
    playbook: { steps },
  };
}

function mockSession(): BrowserSession {
  return {
    goto: vi.fn().mockResolvedValue('ok'),
    click: vi.fn().mockResolvedValue('ok'),
    type: vi.fn().mockResolvedValue('ok'),
    selectOption: vi.fn().mockResolvedValue('ok'),
    waitFor: vi.fn().mockResolvedValue('ok'),
    read: vi.fn().mockResolvedValue('ok'),
    scroll: vi.fn().mockResolvedValue('ok'),
  } as unknown as BrowserSession;
}

describe('replayControllerSpec', () => {
  it('replays a goto + click sequence successfully', async () => {
    const session = mockSession();
    const s = spec([
      { kind: 'browser', action: 'goto', targetText: '', targetLabel: '', url: 'https://example.com', requiresTexts: [] },
      { kind: 'browser', action: 'click', targetText: 'Sign up', targetLabel: '', url: '', requiresTexts: [] },
    ]);
    const result = await replayControllerSpec(s, session);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(session.goto).toHaveBeenCalledWith('https://example.com');
    expect(session.click).toHaveBeenCalledWith({ text: 'Sign up', label: undefined });
  });

  it('falls back to the spec route entry URL when a goto step has no explicit URL', async () => {
    const session = mockSession();
    const s = spec([{ kind: 'browser', action: 'goto', targetText: '', targetLabel: '', url: '', requiresTexts: [] }]);
    await replayControllerSpec(s, session);
    expect(session.goto).toHaveBeenCalledWith('https://example.com');
  });

  it('stops at the first failing step and reports it', async () => {
    const session = mockSession();
    (session.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('element not found'));
    const s = spec([
      { kind: 'browser', action: 'goto', targetText: '', targetLabel: '', url: 'https://example.com', requiresTexts: [] },
      { kind: 'browser', action: 'click', targetText: 'Missing button', targetLabel: '', url: '', requiresTexts: [] },
      { kind: 'browser', action: 'click', targetText: 'Never reached', targetLabel: '', url: '', requiresTexts: [] },
    ]);
    const result = await replayControllerSpec(s, session);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(2); // goto succeeded, click failed, third step never attempted
    expect(result.steps[1]?.ok).toBe(false);
    expect(result.steps[1]?.detail).toContain('element not found');
  });

  it('handles type and select steps', async () => {
    const session = mockSession();
    const s = spec([
      { kind: 'browser', action: 'type', targetText: 'me@example.com', targetLabel: 'Email', url: '', requiresTexts: [] },
      { kind: 'browser', action: 'select', targetText: 'Medium', targetLabel: 'Size', url: '', requiresTexts: [] },
    ]);
    const result = await replayControllerSpec(s, session);
    expect(result.ok).toBe(true);
    expect(session.type).toHaveBeenCalledWith({ text: 'me@example.com', label: 'Email' }, 'me@example.com');
    expect(session.selectOption).toHaveBeenCalledWith({ text: 'Medium', label: 'Size' }, 'Medium');
  });

  it('fails gracefully on an unrecognized step action', async () => {
    const session = mockSession();
    const s = spec([{ kind: 'browser', action: 'teleport', targetText: '', targetLabel: '', url: '', requiresTexts: [] }]);
    const result = await replayControllerSpec(s, session);
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain('unknown playbook step action');
  });

  it('succeeds trivially for an empty playbook', async () => {
    const session = mockSession();
    const result = await replayControllerSpec(spec([]), session);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([]);
  });
});
