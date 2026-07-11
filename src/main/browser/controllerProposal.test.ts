import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposeBrowserControllerIfApplicable } from './controllerProposal';
import type { ToolCall } from '@shared/model';
import type { ToolResult } from '@shared/agent';

function call(name: string, args: Record<string, unknown>, id = 'c1'): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function ok(tool: string): ToolResult {
  return { tool, ok: true, summary: 'ok' };
}

describe('proposeBrowserControllerIfApplicable', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-controller-proposal-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('proposes a spec after a goto + real interaction', async () => {
    const calls = [
      { call: call('browser_goto', { url: 'https://shop.example.com/signup' }), result: ok('browser_goto') },
      { call: call('browser_click', { target: { role: 'button', text: 'Sign up' } }), result: ok('browser_click') },
    ];

    const file = await proposeBrowserControllerIfApplicable({ objective: 'sign up for shop.example.com', workspaceRoot, calls });
    expect(file).not.toBeNull();

    const saved = JSON.parse(await readFile(file!, 'utf8'));
    expect(saved.match.domains).toEqual(['shop.example.com']);
    expect(saved.match.intents).toContain('signup');
    expect(saved.playbook.steps).toHaveLength(2);
    expect(saved.playbook.steps[1].action).toBe('click');
    expect(saved.playbook.steps[1].targetText).toBe('Sign up');
  });

  it('returns null when there was no browser_goto call at all', async () => {
    const calls = [{ call: call('browser_click', { target: { text: 'x' } }), result: ok('browser_click') }];
    expect(await proposeBrowserControllerIfApplicable({ objective: 'x', workspaceRoot, calls })).toBeNull();
  });

  it('returns null for a goto-only run with no real interaction (e.g. a lookup-style browse)', async () => {
    const calls = [
      { call: call('browser_goto', { url: 'https://example.com' }), result: ok('browser_goto') },
      { call: call('browser_read', {}), result: ok('browser_read') },
    ];
    expect(await proposeBrowserControllerIfApplicable({ objective: 'look at example.com', workspaceRoot, calls })).toBeNull();
  });

  it('ignores failed tool calls when building the playbook', async () => {
    const calls = [
      { call: call('browser_goto', { url: 'https://example.com' }), result: ok('browser_goto') },
      { call: call('browser_click', { target: { text: 'A' } }), result: { tool: 'browser_click', ok: false, summary: 'failed' } },
      { call: call('browser_click', { target: { text: 'B' } }), result: ok('browser_click') },
    ];
    const file = await proposeBrowserControllerIfApplicable({ objective: 'x', workspaceRoot, calls });
    const saved = JSON.parse(await readFile(file!, 'utf8'));
    expect(saved.playbook.steps).toHaveLength(2); // goto + the successful click only
    expect(saved.playbook.steps[1].targetText).toBe('B');
  });

  it('returns null for a malformed goto URL', async () => {
    const calls = [
      { call: call('browser_goto', { url: 'not a url' }), result: ok('browser_goto') },
      { call: call('browser_click', { target: { text: 'x' } }), result: ok('browser_click') },
    ];
    expect(await proposeBrowserControllerIfApplicable({ objective: 'x', workspaceRoot, calls })).toBeNull();
  });
});
