import { useEffect, useState } from 'react';
import type { ScheduledTask } from '@shared/schedule';
import { scheduleLabel, whenLabel } from '../lib/friendly';

/** "Routines" — things Geepus does for you on its own, described in plain language. */

const WHEN_CHOICES = [
  { value: '0 8 * * *', label: 'Every morning at 8' },
  { value: '0 18 * * *', label: 'Every evening at 6' },
  { value: 'every 1h', label: 'Every hour' },
  { value: 'every 30m', label: 'Every 30 minutes' },
];

function lastRunLabel(state: string): { text: string; ok: boolean } | null {
  if (state === 'completed') return { text: 'Last run went fine', ok: true };
  if (state === 'failed') return { text: 'Had trouble last time', ok: false };
  if (state === 'running') return { text: 'Running right now…', ok: true };
  return null;
}

export function SchedulesPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [objective, setObjective] = useState('');
  const [schedule, setSchedule] = useState('0 8 * * *');

  async function refresh() {
    setTasks(await window.geepus.schedule.list());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addTask() {
    if (!objective.trim()) return;
    await window.geepus.schedule.add({ objective: objective.trim(), schedule });
    setObjective('');
    await refresh();
  }

  async function toggle(task: ScheduledTask) {
    await window.geepus.schedule.update(task.id, { enabled: !task.enabled });
    await refresh();
  }

  async function remove(id: string) {
    await window.geepus.schedule.remove(id);
    await refresh();
  }

  async function runNow(id: string) {
    await window.geepus.schedule.runNow(id);
    await refresh();
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Routines</h2>
        <p className="muted">Things Geepus takes care of on its own, on a schedule you pick.</p>
      </div>

      <div className="card">
        <h3>Add a routine</h3>
        <label className="field">
          <span>What should Geepus do?</span>
          <input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder='e.g. "Check my inbox and let me know if anything looks urgent"'
          />
        </label>
        <label className="field">
          <span>How often?</span>
          <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
            {WHEN_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={() => void addTask()} disabled={!objective.trim()}>
          Add routine
        </button>
      </div>

      {tasks.length === 0 && (
        <p className="muted center">No routines yet — add one above, and Geepus will handle it from there.</p>
      )}
      {tasks.map((task) => {
        const last = lastRunLabel(task.lastRunState);
        return (
          <div key={task.id} className={`card routine ${task.enabled ? '' : 'paused'}`}>
            <p className="routine-objective">{task.objective}</p>
            <p className="muted">
              {scheduleLabel(task.schedule)}
              {!task.enabled && ' · Paused'}
              {task.enabled && task.nextRunAt ? ` · Next: ${whenLabel(new Date(task.nextRunAt).getTime())}` : ''}
            </p>
            {last && <p className={last.ok ? 'muted' : 'problem'}>{last.text}</p>}
            <div className="row-actions">
              <button onClick={() => void runNow(task.id)}>Run now</button>
              <button onClick={() => void toggle(task)}>{task.enabled ? 'Pause' : 'Resume'}</button>
              <button className="danger" onClick={() => void remove(task.id)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
