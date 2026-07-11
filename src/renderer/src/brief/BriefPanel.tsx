import { useState } from 'react';
import type { DailyBrief } from '@shared/brief';
import { MailSetupPanel } from '../mail/MailSetupPanel';

export function BriefPanel() {
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [ranObjective, setRanObjective] = useState<string | null>(null);

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

  // Parse "- Retry: <objective>" suggestion lines out of the brief text for one-tap buttons.
  const suggestionLines = brief?.text
    .split('\n')
    .filter((line) => line.startsWith('- Retry:'))
    .map((line) => line.replace(/^- Retry:\s*/, ''));

  return (
    <div className="brief-panel">
      <MailSetupPanel />
      <button onClick={() => void generate()} disabled={loading}>
        {loading ? 'Generating…' : brief ? 'Refresh brief' : 'Generate today’s brief'}
      </button>

      {brief && (
        <>
          <pre className="brief-text">{brief.text}</pre>
          {suggestionLines && suggestionLines.length > 0 && (
            <div className="suggestion-actions">
              {suggestionLines.map((objective) => (
                <button key={objective} onClick={() => doIt(objective)} disabled={ranObjective === objective}>
                  {ranObjective === objective ? 'Running…' : `Do it: ${objective}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
