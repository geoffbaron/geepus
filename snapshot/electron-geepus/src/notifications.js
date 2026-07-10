'use strict';

/**
 * notifications.js — macOS native notifications via Electron's Notification API.
 *
 * Provides a thin wrapper for sending desktop notifications when scheduled tasks
 * complete, fail, or need attention.
 */

const { Notification, BrowserWindow } = require('electron');

/**
 * Show a native macOS notification.
 *
 * @param {object} options
 * @param {string} options.title - Notification title
 * @param {string} options.body  - Notification body text
 * @param {'info'|'success'|'warning'|'error'} [options.level='info'] - Severity
 * @param {boolean} [options.focusOnClick=true] - Bring main window to front on click
 * @param {object} [options.meta] - Arbitrary metadata attached to the notification
 */
function notify({ title, body, level = 'info', focusOnClick = true, meta = {} } = {}) {
  if (!Notification.isSupported()) {
    return;
  }

  const subtitle = level === 'error'
    ? 'Error'
    : level === 'warning'
      ? 'Attention needed'
      : level === 'success'
        ? 'Completed'
        : '';

  const notification = new Notification({
    title: String(title || 'Geepus'),
    body: String(body || '').slice(0, 500),
    subtitle,
    silent: level === 'info',
  });

  if (focusOnClick) {
    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const win = windows[0];
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }

  notification.show();
  return notification;
}

/**
 * Notify that a scheduled task completed successfully.
 */
function notifyTaskComplete(taskName, summary) {
  return notify({
    title: `Task complete: ${taskName}`,
    body: summary || 'Geepus finished the scheduled task.',
    level: 'success',
  });
}

/**
 * Notify that a scheduled task failed.
 */
function notifyTaskFailed(taskName, errorMessage) {
  return notify({
    title: `Task failed: ${taskName}`,
    body: errorMessage || 'The scheduled task encountered an error.',
    level: 'error',
  });
}

/**
 * Notify that a scheduled task needs user attention (approval, input, etc).
 */
function notifyTaskNeedsAttention(taskName, reason) {
  return notify({
    title: `Needs attention: ${taskName}`,
    body: reason || 'Geepus needs your input to continue.',
    level: 'warning',
  });
}

/**
 * Notify that a trigger fired and work is beginning.
 */
function notifyTriggerFired(triggerName, taskName) {
  return notify({
    title: `Trigger fired: ${triggerName}`,
    body: `Starting task "${taskName}"...`,
    level: 'info',
  });
}

/**
 * Notify a proactive suggestion from Geepus.
 */
function notifyProactiveSuggestion(title, suggestion) {
  return notify({
    title: title || 'Geepus has a suggestion',
    body: suggestion,
    level: 'info',
  });
}

module.exports = {
  notify,
  notifyTaskComplete,
  notifyTaskFailed,
  notifyTaskNeedsAttention,
  notifyTriggerFired,
  notifyProactiveSuggestion,
};
