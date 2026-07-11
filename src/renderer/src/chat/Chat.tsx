import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/model';
import { activityLabel } from '../lib/friendly';
import { Orb } from '../components/Orb';

/**
 * The one conversation. Every message runs through the full agent runtime, so Geepus can
 * just answer, or look things up, or actually do things — the user never has to know the
 * difference. Technical detail (which tools ran, what they returned) lives behind a
 * per-reply "See how I did this" disclosure.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Technical steps behind this reply — for the optional disclosure. */
  steps?: string[];
  failed?: boolean;
}

const SUGGESTIONS = [
  'What can you help me with?',
  "What's the weather looking like today?",
  'Remember that I prefer short answers',
  'Summarize my day',
];

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return window.geepus.models.onBundledDownloadProgress(({ downloadedBytes, totalBytes }) => {
      const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      setDownloadPct(pct < 100 ? pct : null);
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, activity]);

  function send(text?: string) {
    const objective = (text ?? input).trim();
    if (!objective || running) return;

    const history: ChatMessage[] = turns
      .filter((t) => !t.failed)
      .map((t) => ({ role: t.role, content: t.content }));

    setTurns((prev) => [...prev, { role: 'user', content: objective }, { role: 'assistant', content: '', steps: [] }]);
    setInput('');
    setRunning(true);
    setActivity('Thinking');

    const patchReply = (patch: (reply: Turn) => Turn) => {
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = patch(last);
        return next;
      });
    };

    unsubscribeRef.current = window.geepus.runtime.run({ objective, workspaceRoot: '', history }, (event) => {
      switch (event.type) {
        case 'text':
          setActivity(null);
          patchReply((r) => ({ ...r, content: r.content + event.delta }));
          break;
        case 'tool_call':
          setActivity(activityLabel(event.toolCall.name));
          patchReply((r) => ({ ...r, steps: [...(r.steps ?? []), `→ ${event.toolCall.name}(${event.toolCall.arguments})`] }));
          break;
        case 'tool_result':
          patchReply((r) => ({
            ...r,
            steps: [...(r.steps ?? []), `${event.result.ok ? '✓' : '✗'} ${event.result.summary}`],
          }));
          break;
        case 'approval_needed':
          setActivity('Waiting for your OK');
          break;
        case 'approval_resolved':
          setActivity('Working on it');
          break;
        case 'done':
          setRunning(false);
          setActivity(null);
          unsubscribeRef.current?.();
          patchReply((r) => {
            if (r.content.trim()) return event.success ? r : { ...r, failed: true };
            return event.success
              ? { ...r, content: 'Done!' }
              : { ...r, content: "I couldn't finish that one. Mind trying again, maybe with a bit more detail?", failed: true };
          });
          break;
        case 'error':
          setRunning(false);
          setActivity(null);
          unsubscribeRef.current?.();
          patchReply((r) => ({
            ...r,
            failed: true,
            content: r.content.trim() || 'Something went wrong on my end. Give it another try in a moment.',
            steps: [...(r.steps ?? []), `⚠️ ${event.message}`],
          }));
          break;
      }
    });
  }

  return (
    <div className="chat">
      {downloadPct !== null && (
        <div className="notice">
          <span className="spinner" /> Getting your assistant ready… {downloadPct}%
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="welcome">
            <Orb />
            <h1>Hi, I'm Geepus.</h1>
            <p>Your personal assistant — everything stays private, right here on this Mac.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className={`bubble-row ${t.role}`}>
            <div className={`bubble ${t.role} ${t.failed ? 'failed' : ''}`}>
              <p>{t.content || (running && i === turns.length - 1 ? '' : '')}</p>
              {t.role === 'assistant' && (t.steps?.length ?? 0) > 0 && (
                <details className="steps">
                  <summary>See how I did this</summary>
                  <pre>{t.steps!.join('\n')}</pre>
                </details>
              )}
            </div>
          </div>
        ))}

        {activity && (
          <div className="bubble-row assistant">
            <div className="bubble assistant activity">
              <span className="spinner" /> {activity}…
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask me anything, or ask me to do something…"
          disabled={running}
        />
        <button className="primary" onClick={() => send()} disabled={running || !input.trim()}>
          {running ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
