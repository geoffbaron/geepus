/**
 * App auto-update state (electron-updater over GitHub Releases, differential/blockmap
 * downloads so an update only fetches the changed bytes — never the whole app again).
 *
 * Delivery to end users requires the app to be signed (macOS refuses to apply an
 * unsigned update) and the repo/releases to be public (a shipped app can't carry a
 * private-repo token). Until both hold, the updater no-ops cleanly — it never nags.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version?: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };
