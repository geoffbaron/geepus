import { describe, expect, it, vi } from 'vitest';
import { listPendingApprovals, onApprovalRequested, requestApproval, resolveApproval } from './approvals';

describe('approvals queue', () => {
  it('resolves true when approved', async () => {
    const promise = requestApproval({ tool: 'run_command', argsSummary: 'npm install x', riskTier: 'sensitive' });
    const [pending] = listPendingApprovals();
    expect(pending).toBeDefined();
    resolveApproval(pending!.id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when denied', async () => {
    const promise = requestApproval({ tool: 'http_get', argsSummary: 'GET https://example.com', riskTier: 'sensitive' });
    const [pending] = listPendingApprovals();
    resolveApproval(pending!.id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('defaults to deny on timeout', async () => {
    vi.useFakeTimers();
    try {
      const promise = requestApproval({ tool: 'write_file', argsSummary: '/tmp/x', riskTier: 'sensitive', timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      await expect(promise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the approval from the pending list once resolved', async () => {
    const promise = requestApproval({ tool: 'run_command', argsSummary: 'x', riskTier: 'sensitive' });
    const [pending] = listPendingApprovals();
    resolveApproval(pending!.id, true);
    await promise;
    expect(listPendingApprovals().find((p) => p.id === pending!.id)).toBeUndefined();
  });

  it('resolveApproval on an unknown id returns false and does nothing', () => {
    expect(resolveApproval('does-not-exist', true)).toBe(false);
  });

  it('notifies listeners when a new approval is requested', () => {
    const seen: string[] = [];
    const unsubscribe = onApprovalRequested((a) => seen.push(a.tool));
    void requestApproval({ tool: 'my_tool', argsSummary: 'x', riskTier: 'sensitive' }).then((approved) => {
      // resolved below; nothing to assert on the promise itself here
      void approved;
    });
    const [pending] = listPendingApprovals();
    resolveApproval(pending!.id, true);
    unsubscribe();
    expect(seen).toContain('my_tool');
  });
});
