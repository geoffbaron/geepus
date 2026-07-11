import { useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@shared/model';
import { MailSetupPanel } from '../mail/MailSetupPanel';
import { MemoryBrowser } from '../memory/MemoryBrowser';

/**
 * The one Settings page. Everything a normal person needs is a plain-language card;
 * everything technical (which "brain" is running, the dev-only cloud provider) lives
 * under a collapsed "Advanced" section nobody has to open.
 */

const BRAIN_LABELS: Record<ProviderId, { label: string; blurb: string }> = {
  bundled: { label: 'Built-in brain', blurb: 'Comes with Geepus. Works on any Mac, fully offline.' },
  ollama: { label: 'Bigger local brain (Ollama)', blurb: 'Smarter answers, still 100% private on this Mac.' },
  openrouter: { label: 'Cloud brain (developer testing only)', blurb: 'Sends questions to the internet — not private. For development.' },
};

export function PermissionsPanel() {
  const [notificationStatus, setNotificationStatus] = useState<'idle' | 'sent'>('idle');
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderId>('bundled');
  const [developerEnabled, setDeveloperEnabled] = useState(false);

  useEffect(() => {
    void window.geepus.models.listProviders().then(setProviders);
    void window.geepus.settings.get().then((s) => {
      setActiveProvider(s.activeProvider);
      setDeveloperEnabled(s.developer.enabled);
    });
  }, []);

  async function requestNotifications() {
    await window.geepus.setup.requestNotificationPermission();
    setNotificationStatus('sent');
  }

  async function switchBrain(next: ProviderId) {
    const settings = await window.geepus.settings.update({ activeProvider: next });
    setActiveProvider(settings.activeProvider);
  }

  const visibleBrains = providers.filter((p) => p.id !== 'openrouter' || developerEnabled);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Settings</h2>
        <p className="muted">Everything Geepus knows and does stays on this Mac. Nothing is sent anywhere.</p>
      </div>

      <div className="card">
        <h3>Notifications</h3>
        <p className="muted">A heads-up for your daily summary and anything urgent.</p>
        <button onClick={() => void requestNotifications()}>
          {notificationStatus === 'sent' ? 'Test notification sent ✓' : 'Send a test notification'}
        </button>
      </div>

      <MailSetupPanel />

      <div className="card">
        <h3>Things Geepus remembers</h3>
        <MemoryBrowser />
      </div>

      <div className="card">
        <h3>Privacy, in plain words</h3>
        <ul className="plain-list">
          <li>Geepus asks before doing anything sensitive — saving files outside its folder, running commands, buying anything.</li>
          <li>Email access is read-only. Sending or deleting mail isn't just off — it isn't built in.</li>
          <li>It only asks for new access (email, browser, folders) the first time a thing actually needs it.</li>
        </ul>
      </div>

      <details className="advanced card">
        <summary>Advanced</summary>
        <h3>Which brain is Geepus using?</h3>
        <p className="muted">You don't need to touch this — Geepus picked the best option during setup.</p>
        {visibleBrains.map((p) => {
          const info = BRAIN_LABELS[p.id];
          return (
            <label key={p.id} className={`brain-choice ${p.available ? '' : 'unavailable'}`}>
              <input
                type="radio"
                name="brain"
                checked={activeProvider === p.id}
                disabled={!p.available}
                onChange={() => void switchBrain(p.id)}
              />
              <span>
                <strong>{info.label}</strong>
                {!p.available && ' (not available right now)'}
                <br />
                <span className="muted">{info.blurb}</span>
              </span>
            </label>
          );
        })}
      </details>
    </div>
  );
}
