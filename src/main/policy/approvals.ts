import { randomUUID } from 'node:crypto';
import type { PendingApproval, RiskTier } from '@shared/agent';

interface PendingEntry {
  approval: PendingApproval;
  resolve: (approved: boolean) => void;
}

const pending = new Map<string, PendingEntry>();

type ApprovalListener = (approval: PendingApproval) => void;
const listeners = new Set<ApprovalListener>();

export function onApprovalRequested(listener: ApprovalListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()].map((e) => e.approval);
}

/** Returns false if no such pending approval exists (already resolved, expired, or bogus id). */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(approved);
  return true;
}

export interface RequestApprovalOptions {
  tool: string;
  argsSummary: string;
  riskTier: RiskTier;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Blocks the calling tool execution until the user approves/denies via the renderer's
 * Approvals inbox, or the request times out — timeout defaults to deny, never allow
 * (PLAN.md §9: scheduled runs must pause on sensitive actions, not proceed unattended).
 */
export function requestApproval(options: RequestApprovalOptions): Promise<boolean> {
  const id = randomUUID();
  const approval: PendingApproval = {
    id,
    tool: options.tool,
    argsSummary: options.argsSummary,
    riskTier: options.riskTier,
    createdAt: Date.now(),
  };

  return new Promise((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const wrappedResolve = (approved: boolean): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(approved);
    };
    pending.set(id, { approval, resolve: wrappedResolve });
    for (const listener of listeners) listener(approval);

    timeoutHandle = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(false);
      }
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
}
