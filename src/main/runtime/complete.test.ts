import { describe, expect, it } from 'vitest';
import { checkCompletion } from './complete';
import type { ToolResult } from '@shared/agent';

function toolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return { tool: 'http_get', ok: true, summary: 'ok', ...overrides };
}

describe('checkCompletion', () => {
  // Regression test for AGENT_LOOP_INVESTIGATION.md bug #2: hasAnyRealOutput only counted
  // write_file/run_command/run_playwright, so a successful web_search/http_request for a
  // simple lookup could never satisfy it and the run would loop forever.
  describe('regression: lookup completes on any successful tool, not just build tools (bug #2)', () => {
    it('completes after a successful http_get (the weather-check scenario)', () => {
      const result = checkCompletion('lookup', [toolResult({ tool: 'http_get' })], false);
      expect(result.done).toBe(true);
    });

    it('completes after a successful recall/remember (non-build tools)', () => {
      expect(checkCompletion('research', [toolResult({ tool: 'recall' })], false).done).toBe(true);
    });

    it('does NOT complete while only failed tool calls have happened', () => {
      const result = checkCompletion('lookup', [toolResult({ ok: false })], false);
      expect(result.done).toBe(false);
    });

    it('completes on a direct text answer with no tool calls at all', () => {
      expect(checkCompletion('lookup', [], true).done).toBe(true);
    });
  });

  describe('chat', () => {
    it('completes once there is a final text response', () => {
      expect(checkCompletion('chat', [], true).done).toBe(true);
    });

    it('is not done with no text yet', () => {
      expect(checkCompletion('chat', [], false).done).toBe(false);
    });
  });

  describe('build / operate — the only classes that require an artifact', () => {
    it.each(['build', 'operate'] as const)('%s does not complete on http_get alone', (taskClass) => {
      expect(checkCompletion(taskClass, [toolResult({ tool: 'http_get' })], true).done).toBe(false);
    });

    it.each(['build', 'operate'] as const)('%s completes once write_file succeeds', (taskClass) => {
      expect(checkCompletion(taskClass, [toolResult({ tool: 'write_file' })], false).done).toBe(true);
    });

    it.each(['build', 'operate'] as const)('%s completes once run_command succeeds', (taskClass) => {
      expect(checkCompletion(taskClass, [toolResult({ tool: 'run_command' })], false).done).toBe(true);
    });

    it('build does not complete on a FAILED write_file', () => {
      expect(checkCompletion('build', [toolResult({ tool: 'write_file', ok: false })], true).done).toBe(false);
    });

    // PLAN2.md N1 — drafting/proposing counts as the artifact for a "draft an email" /
    // "schedule an appointment" objective (both classify as 'operate').
    it('operate completes once draft_email succeeds', () => {
      expect(checkCompletion('operate', [toolResult({ tool: 'draft_email' })], false).done).toBe(true);
    });

    it('operate completes once propose_event succeeds', () => {
      expect(checkCompletion('operate', [toolResult({ tool: 'propose_event' })], false).done).toBe(true);
    });

    it('operate does not complete on a FAILED draft_email', () => {
      expect(checkCompletion('operate', [toolResult({ tool: 'draft_email', ok: false })], true).done).toBe(false);
    });
  });

  describe('research / browse behave like lookup', () => {
    it.each(['research', 'browse'] as const)('%s completes on any successful tool result', (taskClass) => {
      expect(checkCompletion(taskClass, [toolResult()], false).done).toBe(true);
    });
  });
});
