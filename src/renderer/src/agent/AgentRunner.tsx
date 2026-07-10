import { useRef, useState } from 'react';
import type { AgentEvent } from '@shared/agent';

function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'classified':
      return `Classified as: ${event.taskClass}`;
    case 'iteration_start':
      return `— iteration ${event.iteration} —`;
    case 'text':
      return event.delta;
    case 'tool_call':
      return `→ calling ${event.toolCall.name}(${event.toolCall.arguments})`;
    case 'tool_result':
      return `${event.result.ok ? '✓' : '✗'} ${event.result.summary}`;
    case 'approval_needed':
      return `⏸ waiting for approval: ${event.tool} — ${event.argsSummary}`;
    case 'approval_resolved':
      return event.approved ? '✓ approved' : '✗ denied';
    case 'done':
      return event.success
        ? `✅ Done — ${event.reason}${event.reflection ? `\n💭 ${event.reflection}` : ''}`
        : `❌ Stopped — ${event.reason}`;
    case 'error':
      return `⚠️ ${event.message}`;
    default:
      return '';
  }
}

export function AgentRunner() {
  const [objective, setObjective] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  function run() {
    const text = objective.trim();
    if (!text || running) return;
    setLog([]);
    setRunning(true);

    unsubscribeRef.current = window.geepus.runtime.run({ objective: text, workspaceRoot: '' }, (event) => {
      setLog((prev) => [...prev, describeEvent(event)]);
      if (event.type === 'done' || event.type === 'error') {
        setRunning(false);
        unsubscribeRef.current?.();
      }
    });
  }

  return (
    <div className="agent-runner">
      <div className="composer">
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          placeholder="Give Geepus an objective…"
          disabled={running}
        />
        <button onClick={run} disabled={running || !objective.trim()}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      <pre className="agent-log">{log.join('\n')}</pre>
    </div>
  );
}
