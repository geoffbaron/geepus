import { useEffect, useState } from 'react';

/**
 * Email connect, dad-proof: type your address, Geepus figures out the rest and walks you
 * through getting an "app password" (with a button that opens the exact right page).
 * Server host/port only exist under "Advanced", and only demand attention when the
 * address isn't from a provider we recognize.
 */

interface MailProvider {
  label: string;
  host: string;
  domains: string[];
  helpUrl: string | null;
  passwordHint: string;
}

const PROVIDERS: Record<string, MailProvider> = {
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

function detectProvider(email: string): { id: string; provider: MailProvider } | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (provider.domains.includes(domain)) return { id, provider };
  }
  return null;
}

export function MailSetupPanel() {
  const [configured, setConfigured] = useState(false);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [hostTouched, setHostTouched] = useState(false);
  const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'problem'; text: string } | null>(null);

  useEffect(() => {
    void window.geepus.mail.isConfigured().then(setConfigured);
  }, []);

  const detected = detectProvider(email);
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
    setConfigured(true);
    setPass('');
    setStatus(null);
  }

  if (configured) {
    return (
      <div className="card">
        <p>
          ✅ <strong>Email is connected.</strong> Geepus reads new mail to build your daily summary — it can never
          send, move, or delete anything.
        </p>
        <button onClick={() => setConfigured(false)}>Use a different account</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Connect your email</h3>
      <p className="muted">
        Geepus reads your unread mail to include it in your daily summary. It can only <em>read</em> — sending,
        moving, or deleting isn't possible, by design.
      </p>

      <label className="field">
        <span>Your email address</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
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
          <summary>Advanced</summary>
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
    </div>
  );
}
