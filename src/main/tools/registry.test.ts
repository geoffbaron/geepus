import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool, getToolDefinitions } from './registry';
import { listPendingApprovals, resolveApproval } from '../policy/approvals';
import { AuditLog } from '../policy/audit';

describe('getToolDefinitions', () => {
  it('exposes all fifteen tools (M3 core + M6 browser)', () => {
    const names = getToolDefinitions().map((t) => t.name).sort();
    expect(names).toEqual([
      'browser_click',
      'browser_find',
      'browser_goto',
      'browser_read',
      'browser_scroll',
      'browser_select',
      'browser_type',
      'browser_wait_for',
      'http_get',
      'list_files',
      'read_file',
      'recall',
      'remember',
      'run_command',
      'write_file',
    ]);
  });
});

describe('executeTool', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-registry-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns an error result for an unknown tool without throwing', async () => {
    const result = await executeTool({ toolName: 'nope', args: {}, context: { workspaceRoot } });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/unknown tool/i);
  });

  // Regression test: a live run against a real (weak, 1B) Ollama model produced a
  // malformed/mis-nested tool call for http_get with no `url` key. Before this fix, that
  // fell through to risk classification ("undefined" isn't a valid URL -> not allowlisted
  // -> 'sensitive'), which then blocked forever waiting on an approval nobody would ever
  // resolve — a genuine deadlock, not a hypothetical. It must now fail fast instead.
  it('regression: missing a required argument fails immediately, with no approval prompt', async () => {
    const result = await executeTool({
      toolName: 'http_get',
      args: { function: '{"name":"http_get","parameters":{"url":"https://example.com"}}' }, // malformed/nested, no top-level `url`
      context: { workspaceRoot },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/missing required argument: url/i);
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it('the missing-argument check applies to every tool with required args, e.g. write_file', async () => {
    const result = await executeTool({ toolName: 'write_file', args: { path: 'a.txt' }, context: { workspaceRoot } });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/missing required argument: content/i);
  });

  it('auto-allows a write inside the workspace and the file actually exists afterward', async () => {
    const result = await executeTool({
      toolName: 'write_file',
      args: { path: 'notes.txt', content: 'hello' },
      context: { workspaceRoot },
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(workspaceRoot, 'notes.txt'), 'utf8')).toBe('hello');
  });

  it('reads back what it wrote', async () => {
    await executeTool({ toolName: 'write_file', args: { path: 'a.txt', content: 'xyz' }, context: { workspaceRoot } });
    const result = await executeTool({ toolName: 'read_file', args: { path: 'a.txt' }, context: { workspaceRoot } });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('xyz');
  });

  it('hard-denies a dangerous command outright, with no approval prompt', async () => {
    const result = await executeTool({ toolName: 'run_command', args: { command: 'sudo rm -rf /' }, context: { workspaceRoot } });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/hard-denied/);
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it('asks for approval on a write outside the workspace, and proceeds once approved', async () => {
    const outsidePath = join(tmpdir(), `geepus-outside-${Date.now()}.txt`);
    const promise = executeTool({
      toolName: 'write_file',
      args: { path: outsidePath, content: 'outside' },
      context: { workspaceRoot },
    });

    // Let the approval request register before we resolve it.
    await new Promise((r) => setTimeout(r, 0));
    const [pending] = listPendingApprovals();
    expect(pending?.tool).toBe('write_file');
    resolveApproval(pending!.id, true);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(await readFile(outsidePath, 'utf8')).toBe('outside');
    await rm(outsidePath, { force: true });
  });

  it('does not execute a sensitive action if the approval is denied', async () => {
    const outsidePath = join(tmpdir(), `geepus-denied-${Date.now()}.txt`);
    const promise = executeTool({
      toolName: 'write_file',
      args: { path: outsidePath, content: 'nope' },
      context: { workspaceRoot },
    });
    await new Promise((r) => setTimeout(r, 0));
    const [pending] = listPendingApprovals();
    resolveApproval(pending!.id, false);

    const result = await promise;
    expect(result.ok).toBe(false);
    await expect(readFile(outsidePath, 'utf8')).rejects.toThrow();
  });

  it('writes an audit entry for every path: auto-allowed, hard-denied, and denied', async () => {
    const auditLog = new AuditLog(join(workspaceRoot, 'audit.log'));
    await auditLog.init();

    await executeTool({ toolName: 'write_file', args: { path: 'a.txt', content: 'x' }, context: { workspaceRoot }, auditLog });
    await executeTool({ toolName: 'run_command', args: { command: 'sudo rm -rf /' }, context: { workspaceRoot }, auditLog });

    const outsidePath = join(tmpdir(), `geepus-audit-${Date.now()}.txt`);
    const promise = executeTool({ toolName: 'write_file', args: { path: outsidePath, content: 'x' }, context: { workspaceRoot }, auditLog });
    await new Promise((r) => setTimeout(r, 0));
    resolveApproval(listPendingApprovals()[0]!.id, false);
    await promise;

    const lines = (await readFile(join(workspaceRoot, 'audit.log'), 'utf8')).trim().split('\n');
    const decisions = lines.map((l) => (JSON.parse(l) as { decision: string }).decision);
    expect(decisions).toEqual(['auto-allowed', 'hard-denied', 'denied']);
  });

  it('remember/recall round-trip a note', async () => {
    await executeTool({ toolName: 'remember', args: { text: 'the sky is blue' }, context: { workspaceRoot } });
    const result = await executeTool({ toolName: 'recall', args: { query: 'sky' }, context: { workspaceRoot } });
    expect(result.output).toContain('the sky is blue');
  });

  it('auto-allows an http_get to an allowlisted domain (real network call)', async () => {
    const result = await executeTool({
      toolName: 'http_get',
      args: { url: 'https://api.github.com/zen' },
      context: { workspaceRoot },
    });
    expect(result.ok).toBe(true);
    expect(listPendingApprovals()).toHaveLength(0);
  });
});
