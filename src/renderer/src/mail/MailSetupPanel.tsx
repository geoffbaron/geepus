import { useEffect, useState } from 'react';
import type { WebmailProviderId } from '@shared/webmail';

/**
 * Email connect, dad-proof: click "Connect Gmail", a real browser window opens, sign in
 * exactly like you always do (password, 2FA, everything) — Geepus never sees the
 * password. This is the default path (PLAN2.md N2); the old IMAP/app-password flow still
 * works but lives behind "Use a mail password instead" for people who prefer it.
 */

export function MailSetupPanel() {
  const [connected, setConnected] = useState(false);
  const [connectedProvider, setConnectedProvider] = useState<WebmailProviderId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [imapConfigured, setImapConfigured] = useState(false);

  async function refresh() {
    const [webmailStatus, imapDone] = await Promise.all([window.geepus.webmail.getStatus(), window.geepus.mail.isConfigured()]);
    setConnected(webmailStatus.connected);
    setConnectedProvider(webmailStatus.provider);
    setImapConfigured(imapDone);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function connectGmail() {
    setConnecting(true);
    setStatus('Opening a sign-in window — sign in there like you normally would, then come back here.');
    try {
      await window.geepus.webmail.connect('gmail');
    } catch {
      setStatus("Couldn't open the sign-in window. Try again in a moment.");
      setConnecting(false);
    }
  }

  async function checkConnection() {
    setStatus('Checking…');
    const result = await window.geepus.webmail.checkStatus('gmail');
    if (result.connected) {
      setConnected(true);
      setConnectedProvider(result.provider);
      setConnecting(false);
      setStatus(null);
    } else {
      setStatus("Doesn't look signed in yet — finish signing in in that window, then try again.");
    }
  }

  async function disconnect() {
    await window.geepus.webmail.disconnect();
    setConnected(false);
    setConnectedProvider(null);
  }

  if (connected) {
    return (
      <div className="card">
        <p>
          ✅ <strong>Email is connected{connectedProvider ? ` (${connectedProvider === 'gmail' ? 'Gmail' : connectedProvider})` : ''}.</strong>{' '}
          Geepus reads new mail to build your daily summary — it can never send, move, or delete anything.
        </p>
        <button onClick={() => void disconnect()}>Disconnect</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Connect your email</h3>
      <p className="muted">
        Sign in once, in a real browser window — the same way you always sign into email. Geepus never sees or
        stores your password. It can only <em>read</em> mail to build your daily summary; sending, moving, or
        deleting isn't possible, by design.
      </p>

      <button className="primary" onClick={() => void connectGmail()} disabled={connecting}>
        Connect Gmail
      </button>
      <p className="muted">More providers coming soon.</p>

      {connecting && (
        <div className="helper">
          {status && <p>{status}</p>}
          <button onClick={() => void checkConnection()}>I'm signed in — check now</button>
        </div>
      )}

      <details className="advanced">
        <summary>Use a mail password instead</summary>
        <ImapAdvancedForm configured={imapConfigured} onConfigured={() => setImapConfigured(true)} />
      </details>
    </div>
  );
}

interface MailProvider {
  label: string;
  host: string;
  domains: string[];
  helpUrl: string | null;
  passwordHint: string;
}

const IMAP_PROVIDERS: Record<string, MailProvider> = {
  gmail: {
    label: 'Gmail',
    host: 'imap.gmail.com',
    domains: ['gmail.com', 'googlemail.com'],
    helpUrl: 'https://myaccount.google.com/apppasswords',
    passwordHint: 'Sign in, then choose "Create app password". Name it "Geepus" and copy the 16-letter password it gives you.',
  },
  icloud: {
    label: 'iCloud',
    host: 'imap.mail.me.com',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    helpUrl: 'https://account.apple.com/account/manage',
    passwordHint: 'Sign in, find "App-Specific Passwords", and create one named "Geepus".',
  },
  outlook: {
    label: 'Outlook',
    host: 'outlook.office365.com',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    helpUrl: 'https://account.live.com/proofs/AppPassword',
    passwordHint: 'Sign in and create a new app password for Geepus.',
  },
  fastmail: {
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    domains: ['fastmail.com', 'fastmail.fm'],
    helpUrl: 'https://app.fastmail.com/settings/security/devicekeys',
    passwordHint: 'Create a new app password with "Mail (IMAP)" access, named "Geepus".',
  },
};

function detectImapProvider(email: string): { id: string; provider: MailProvider } | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  for (const [id, provider] of Object.entries(IMAP_PROVIDERS)) {
    if (provider.domains.includes(domain)) return { id, provider };
  }
  return null;
}

/** The original app-password flow — kept working for anyone who prefers it, but no
 * longer the default path (see MailSetupPanel above). */
function ImapAdvancedForm({ configured, onConfigured }: { configured: boolean; onConfigured: () => void }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [hostTouched, setHostTouched] = useState(false);
  const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'problem'; text: string } | null>(null);

  const detected = detectImapProvider(email);
  const hasAddress = email.includes('@') && email.split('@')[1]!.includes('.');
  const effectiveHost = hostTouched ? host : (detected?.provider.host ?? host);
  const unknownProvider = hasAddress && !detected;

  async function connect() {
    setStatus({ kind: 'busy', text: 'Checking the connection…' });
    const config = { host: effectiveHost, port, secure: true, user: email.trim(), pass };
    const result = await window.geepus.mail.testConnection(config);
    if (!result.ok) {
      setStatus({
        kind: 'problem',
        text: "That didn't work — double-check the email address and app password. (The app password is different from your normal password.)",
      });
      return;
    }
    await window.geepus.mail.saveAccount(config);
    setPass('');
    setStatus(null);
    onConfigured();
  }

  if (configured) {
    return <p className="muted">✓ A mail-password account is also configured (used only if no email is connected above).</p>;
  }

  return (
    <>
      <label className="field">
        <span>Your email address</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
      </label>

      {detected && (
        <div className="helper">
          <p>
            <strong>{detected.provider.label}</strong> — got it. You'll need an <strong>app password</strong>: a
            special password just for Geepus, so your real password stays secret.
          </p>
          <p className="muted">{detected.provider.passwordHint}</p>
          {detected.provider.helpUrl && (
            <button onClick={() => void window.geepus.app.openHelpLink(detected.provider.helpUrl!)}>
              Open the page where I can create one
            </button>
          )}
        </div>
      )}

      {unknownProvider && (
        <div className="helper">
          <p>
            I don't recognize that email provider, so I need one extra detail — the "incoming mail server" name.
            It's usually on your provider's help pages (search for "<em>{email.split('@')[1]} IMAP settings</em>").
          </p>
          <label className="field">
            <span>Incoming mail server</span>
            <input value={effectiveHost} onChange={(e) => { setHost(e.target.value); setHostTouched(true); }} placeholder="mail.example.com" />
          </label>
        </div>
      )}

      {hasAddress && (
        <label className="field">
          <span>App password</span>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Paste it here" />
        </label>
      )}

      {hasAddress && (
        <details className="advanced">
          <summary>Server details</summary>
          <label className="field">
            <span>Mail server (IMAP host)</span>
            <input value={effectiveHost} onChange={(e) => { setHost(e.target.value); setHostTouched(true); }} />
          </label>
          <label className="field">
            <span>Port</span>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </details>
      )}

      <button className="primary" onClick={() => void connect()} disabled={!hasAddress || !pass || !effectiveHost || status?.kind === 'busy'}>
        {status?.kind === 'busy' ? 'Connecting…' : 'Connect'}
      </button>
      {status && status.kind !== 'busy' && <p className={status.kind === 'problem' ? 'problem' : 'muted'}>{status.text}</p>}
    </>
  );
}
