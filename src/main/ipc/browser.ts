import { ipcMain } from 'electron';
import { listProposedBrowserControllerSpecs, promoteProposedBrowserControllerSpec } from '../browser/controllerRegistry';
import { defaultWorkspaceRoot } from '../runtime/workspace';

export function registerBrowserIpc(): void {
  ipcMain.handle('browser.listProposedControllers', (_event, workspaceRoot?: string) =>
    listProposedBrowserControllerSpecs(workspaceRoot || defaultWorkspaceRoot()),
  );

  ipcMain.handle('browser.promoteController', (_event, specId: string, workspaceRoot?: string) =>
    promoteProposedBrowserControllerSpec(workspaceRoot || defaultWorkspaceRoot(), specId),
  );
}
