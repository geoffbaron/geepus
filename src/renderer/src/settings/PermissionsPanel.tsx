import { useState } from 'react';

interface PermissionInfo {
  name: string;
  description: string;
  when: string;
}

// Everything but notifications is requested by the feature that needs it, the first time
// it's needed — this panel is where a user can read ahead of time what that will involve
// (PLAN.md §6.6). It's informational for now; later milestones make these gates real.
const DEFERRED_PERMISSIONS: PermissionInfo[] = [
  {
    name: 'Email (IMAP, read-only)',
    description: "Lets the Inbox agent read your unread mail to summarize it. Geepus never sends, moves, or deletes mail without your explicit approval.",
    when: 'Requested when you turn on the Inbox agent.',
  },
  {
    name: 'Browser automation',
    description: 'Lets the Browser agent complete web tasks for you, either in a private built-in browser or by driving your real Chrome via the Geepus extension.',
    when: 'Requested the first time you ask Geepus to do something in a browser.',
  },
  {
    name: 'Folder access',
    description: 'Lets Geepus read and write files inside a specific project folder for a task.',
    when: 'Requested the first time a task needs a workspace folder.',
  },
];

export function PermissionsPanel() {
  const [notificationStatus, setNotificationStatus] = useState<'unknown' | 'granted' | 'unsupported'>('unknown');

  async function requestNotifications() {
    const granted = await window.geepus.setup.requestNotificationPermission();
    setNotificationStatus(granted ? 'granted' : 'unsupported');
  }

  return (
    <div className="permissions-panel">
      <h2>Permissions</h2>
      <p className="hint">Geepus asks for each of these only when it's actually needed — never all at once.</p>

      <section className="permission-item">
        <h3>Notifications</h3>
        <p>Used for your daily brief and urgent inbox items. Requested once, up front.</p>
        <button onClick={() => void requestNotifications()}>
          {notificationStatus === 'granted' ? 'Notification sent ✓' : 'Send a test notification'}
        </button>
      </section>

      {DEFERRED_PERMISSIONS.map((p) => (
        <section key={p.name} className="permission-item">
          <h3>{p.name}</h3>
          <p>{p.description}</p>
          <p className="hint">{p.when}</p>
        </section>
      ))}
    </div>
  );
}
