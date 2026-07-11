import { useEffect, useState } from 'react';

const PROVIDER_PRESETS: Record<string, { host: string; port: number; secure: boolean; label: string }> = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, label: 'Gmail' },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, label: 'iCloud' },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, label: 'Outlook' },
  fastmail: { host: 'imap.fastmail.com', port: 993, secure: true, label: 'Fastmail' },
  custom: { host: '', port: 993, secure: true, label: 'Custom' },
};

export function MailSetupPanel() {
  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState('gmail');
  const [host, setHost] = useState(PROVIDER_PRESETS['gmail']!.host);
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    void window.geepus.mail.isConfigured().then(setConfigured);
  }, []);

  function selectProvider(id: string) {
    setProvider(id);
    const preset = PROVIDER_PRESETS[id];
    if (preset) {
      setHost(preset.host);
      setPort(preset.port);
      setSecure(preset.secure);
    }
  }

  async function testAndSave() {
    setStatus('Testing connection…');
    const result = await window.geepus.mail.testConnection({ host, port, secure, user, pass });
    if (!result.ok) {
      setStatus(`Connection failed: ${result.error}`);
      return;
    }
    await window.geepus.mail.saveAccount({ host, port, secure, user, pass });
    setConfigured(true);
    setPass('');
    setStatus('Connected — Geepus can now read (never send, mark, or delete) your unread mail.');
  }

  if (configured) {
    return (
      <div className="mail-setup">
        <p>✓ Email is connected (read-only). Geepus never sends, marks, or deletes mail.</p>
        <button onClick={() => setConfigured(false)}>Reconfigure</button>
      </div>
    );
  }

  return (
    <div className="mail-setup">
      <p className="hint">
        Geepus reads unread mail to summarize it for your daily brief — it can never send, mark, or delete
        anything. Use an app-specific password, not your real account password.
      </p>
      <div className="mail-provider-select">
        {Object.entries(PROVIDER_PRESETS).map(([id, preset]) => (
          <button key={id} className={provider === id ? 'active' : ''} onClick={() => selectProvider(id)}>
            {preset.label}
          </button>
        ))}
      </div>
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IMAP host" />
      <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} placeholder="Port" />
      <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Email address" />
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="App password" />
      <button onClick={() => void testAndSave()} disabled={!host || !user || !pass}>
        Test & connect
      </button>
      {status && <p className="hint">{status}</p>}
    </div>
  );
}
