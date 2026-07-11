import { useEffect, useState } from 'react';
import type { PendingApproval } from '@shared/agent';
import { approvalLabel } from '../lib/friendly';

/**
 * Friendly permission cards, shown wherever you are the moment Geepus needs an OK —
 * there is no "Approvals" tab to know about. Raw tool name + arguments stay behind a
 * "details" disclosure for the curious.
 */
export function ApprovalRequests() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  async function refresh() {
    setApprovals(await window.geepus.runtime.listPendingApprovals());
  }

  useEffect(() => {
    void refresh();
    return window.geepus.runtime.onApprovalRequested(() => void refresh());
  }, []);

  async function respond(id: string, approved: boolean) {
    await window.geepus.runtime.resolveApproval(id, approved);
    void refresh();
  }

  if (approvals.length === 0) return null;

  return (
    <div className="approval-stack">
      {approvals.map((a) => (
        <div key={a.id} className="approval-card">
          <p>
            <strong>Geepus would like to {approvalLabel(a.tool)}.</strong> Is that OK?
          </p>
          <details>
            <summary>details</summary>
            <p className="mono">
              {a.tool}: {a.argsSummary}
            </p>
          </details>
          <div className="approval-actions">
            <button className="primary" onClick={() => void respond(a.id, true)}>
              Yes, go ahead
            </button>
            <button onClick={() => void respond(a.id, false)}>No, don't</button>
          </div>
        </div>
      ))}
    </div>
  );
}
