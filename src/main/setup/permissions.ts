import { Notification } from 'electron';

/**
 * The only permission the wizard asks for up front (PLAN.md §6.6) — everything else
 * (IMAP, browser automation, folder access) is requested the first time a task actually
 * needs it, from wherever that feature lives, not here.
 */
export function isNotificationSupported(): boolean {
  return Notification.isSupported();
}

export function showWelcomeNotification(): boolean {
  if (!Notification.isSupported()) return false;
  new Notification({
    title: 'Geepus is ready',
    body: "I'll notify you here for daily briefs and anything urgent — nothing else.",
  }).show();
  return true;
}
