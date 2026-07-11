import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRequest } from '@shared/agent';
import { runObjective } from '../runtime/loop';
import { defaultWorkspaceRoot } from '../runtime/workspace';
import { resolveActiveProvider } from '../models/service';
import { getBundledModelPath } from '../models/bootstrap';
import { loadSecrets, loadSettings } from '../settings/store';
import { AuditLog } from '../policy/audit';
import { listPendingApprovals, onApprovalRequested, resolveApproval } from '../policy/approvals';
import { getMemoryService } from '../memory/instance';

export function registerRuntimeIpc(): void {
  // Approvals are cross-cutting (a scheduled run could raise one with no chat window
  // actively watching it), so they broadcast on a fixed channel to every window rather
  // than being folded into one run's own event stream.
  onApprovalRequested((approval) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('runtime.approvalRequested', approval);
    }
  });

  ipcMain.handle('runtime.run', async (event, requestId: string, request: RunRequest) => {
    const channel = `runtime.event:${requestId}`;
    const workspaceRoot = request.workspaceRoot || defaultWorkspaceRoot();
    await mkdir(workspaceRoot, { recursive: true });

    const userDataDir = app.getPath('userData');
    const [settings, secrets] = await Promise.all([loadSettings(userDataDir), loadSecrets(userDataDir)]);

    try {
      const provider = resolveActiveProvider({ settings, secrets, bundledModelPath: getBundledModelPath() });
      const auditLog = new AuditLog(join(userDataDir, 'audit.log'));
      await auditLog.init();
      const memory = getMemoryService(settings.ollama.baseUrl);

      for await (const agentEvent of runObjective({
        objective: request.objective,
        workspaceRoot,
        provider,
        budgets: request.budgets,
        auditLog,
        memory,
        history: request.history,
      })) {
        event.sender.send(channel, agentEvent);
      }
    } catch (err) {
      event.sender.send(channel, { type: 'error', message: (err as Error).message });
    }
  });

  ipcMain.handle('runtime.listPendingApprovals', () => listPendingApprovals());
  ipcMain.handle('runtime.resolveApproval', (_event, id: string, approved: boolean) => resolveApproval(id, approved));
}
