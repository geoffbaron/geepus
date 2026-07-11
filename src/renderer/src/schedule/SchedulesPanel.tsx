import { useEffect, useState } from 'react';
import type { ScheduledTask } from '@shared/schedule';

export function SchedulesPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [schedule, setSchedule] = useState('every 30m');

  async function refresh() {
    setTasks(await window.geepus.schedule.list());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addTask() {
    if (!objective.trim()) return;
    await window.geepus.schedule.add({ name: name.trim() || undefined, objective: objective.trim(), schedule });
    setName('');
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
    <div className="schedules-panel">
      <div className="schedule-form">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
        <input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Objective…" />
        <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
          <option value="every 30m">Every 30 min</option>
          <option value="every 1h">Every hour</option>
          <option value="0 8 * * *">Daily at 8am</option>
          <option value="loop">Loop continuously</option>
        </select>
        <button onClick={() => void addTask()} disabled={!objective.trim()}>
          Add
        </button>
      </div>

      <div className="schedule-list">
        {tasks.length === 0 && <p className="hint">No scheduled tasks yet.</p>}
        {tasks.map((task) => (
          <div key={task.id} className="schedule-item">
            <div className="schedule-item-main">
              <strong>{task.name}</strong>
              <span className="pill">{task.schedule}</span>
              {task.lastRunState && <span className={`pill status-${task.lastRunState}`}>{task.lastRunState}</span>}
            </div>
            <p>{task.objective}</p>
            <p className="hint">
              {task.nextRunAt ? `Next: ${new Date(task.nextRunAt).toLocaleString()}` : 'Not scheduled'}
            </p>
            <div className="schedule-actions">
              <button onClick={() => void runNow(task.id)}>Run now</button>
              <button onClick={() => void toggle(task)}>{task.enabled ? 'Disable' : 'Enable'}</button>
              <button onClick={() => void remove(task.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
