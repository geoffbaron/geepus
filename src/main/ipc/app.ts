import { ipcMain, app, shell } from 'electron';

/**
 * The renderer can only open these exact pages — the mail-setup helper's "show me where
 * to get an app password" links. An allowlist (not a scheme check) because openExternal
 * from a renderer is a classic injection target; nothing else in the app needs links out.
 */
const EXTERNAL_URL_ALLOWLIST = new Set([
  'https://myaccount.google.com/apppasswords',
  'https://account.apple.com/account/manage',
  'https://account.live.com/proofs/AppPassword',
  'https://app.fastmail.com/settings/security/devicekeys',
]);

export function registerAppIpc(): void {
  ipcMain.handle('app.getVersion', () => app.getVersion());
  ipcMain.handle('app.openHelpLink', async (_event, url: string) => {
    if (!EXTERNAL_URL_ALLOWLIST.has(url)) return false;
    await shell.openExternal(url);
    return true;
  });
}
