import { useEffect, useState } from 'react';
import type { DailyBrief } from '@shared/brief';
import { MailSetupPanel } from '../mail/MailSetupPanel';

/** "Today" — your daily summary, one button, no setup required (email just makes it richer). */
export function BriefPanel() {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null);
  const [showMailSetup, setShowMailSetup] = useState(false);
  const [ranObjective, setRanObjective] = useState<string | null>(null);

  useEffect(() => {
    void window.geepus.mail.isConfigured().then(setMailConfigured);
  }, [showMailSetup]);

  async function generate() {
    setLoading(true);
    try {
      setBrief(await window.geepus.brief.generate());
    } finally {
      setLoading(false);
    }
  }

  function doIt(objective: string) {
    setRanObjective(objective);
    const unsubscribe = window.geepus.runtime.run({ objective, workspaceRoot: '' }, (event) => {
      if (event.type === 'done' || event.type === 'error') {
        unsubscribe();
        setRanObjective(null);
      }
    });
  }

  // Suggestion lines ("- Retry: <objective>") become one-tap buttons instead of raw text.
  const suggestionLines = brief?.text
    .split('\n')
    .filter((line) => line.startsWith('- Retry:'))
    .map((line) => line.replace(/^- Retry:\s*/, ''));
  const briefBody = brief?.text
    .split('\n')
    .filter((line) => !line.startsWith('- Retry:'))
    .join('\n')
    .trim();

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Today</h2>
        <p className="muted">A quick summary of what's going on, whenever you want it.</p>
      </div>

      <button className="primary big" onClick={() => void generate()} disabled={loading}>
        {loading ? 'Putting it together…' : brief ? 'Update my summary' : "What's my day look like?"}
      </button>

      {brief && (
        <>
          <div className="card brief-text">{briefBody}</div>
          {suggestionLines && suggestionLines.length > 0 && (
            <div className="card">
              <h3>Want me to take care of something?</h3>
              {suggestionLines.map((objective) => (
                <button key={objective} onClick={() => doIt(objective)} disabled={ranObjective === objective}>
                  {ranObjective === objective ? 'On it…' : objective}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {mailConfigured === false && !showMailSetup && (
        <div className="card subtle">
          <p>
            <strong>Want your email in here too?</strong> Connect it once and your summary will include what's new in
            your inbox.
          </p>
          <button onClick={() => setShowMailSetup(true)}>Connect my email</button>
        </div>
      )}
      {showMailSetup && <MailSetupPanel />}
    </div>
  );
}
