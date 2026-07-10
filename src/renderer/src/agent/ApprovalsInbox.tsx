import { useEffect, useState } from 'react';
import type { PendingApproval } from '@shared/agent';

export function ApprovalsInbox() {
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

  if (approvals.length === 0) {
    return <p className="hint">No pending approvals.</p>;
  }

  return (
    <div className="approvals-inbox">
      {approvals.map((a) => (
        <div key={a.id} className="approval-item">
          <span className={`pill risk-${a.riskTier}`}>{a.riskTier}</span>
          <strong>{a.tool}</strong>
          <p>{a.argsSummary}</p>
          <div className="approval-actions">
            <button onClick={() => void respond(a.id, true)}>Approve</button>
            <button onClick={() => void respond(a.id, false)}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}
