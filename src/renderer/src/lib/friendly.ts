/**
 * Plain-language descriptions of everything technical the app might surface.
 * The rule (per Geoff): nobody should see a tool name, provider id, or cron
 * string unless they went looking for it under "details" or "Advanced".
 */

/** What Geepus is doing right now, present tense — shown as a live activity line. */
export function activityLabel(tool: string): string {
  if (tool.startsWith('browser_')) return 'Using the browser';
  switch (tool) {
    case 'read_file':
      return 'Reading a file';
    case 'write_file':
      return 'Saving a file';
    case 'list_files':
      return 'Looking through files';
    case 'run_command':
      return 'Working on this Mac';
    case 'http_get':
      return 'Checking the web';
    case 'recall':
      return 'Checking my notes';
    case 'remember':
      return 'Making a note';
    default:
      return 'Working on it';
  }
}

/** What Geepus wants permission to do — completes the sentence "Geepus would like to …". */
export function approvalLabel(tool: string): string {
  if (tool.startsWith('browser_')) return 'do something on a website';
  switch (tool) {
    case 'read_file':
      return 'read a file';
    case 'write_file':
      return 'save a file';
    case 'list_files':
      return 'look through a folder';
    case 'run_command':
      return 'run a command on this Mac';
    case 'http_get':
      return 'look something up online';
    case 'recall':
      return 'check its notes';
    case 'remember':
      return 'make a note';
    default:
      return `use "${tool}"`;
  }
}

/** Human phrasing for a schedule string ("every 30m", cron, "loop"). */
export function scheduleLabel(schedule: string): string {
  if (schedule === 'loop') return 'Runs continuously';
  const interval = /^every\s+(\d+)\s*(m|h)$/i.exec(schedule.trim());
  if (interval) {
    const n = Number(interval[1]);
    if (interval[2]?.toLowerCase() === 'h') return n === 1 ? 'Every hour' : `Every ${n} hours`;
    return `Every ${n} minutes`;
  }
  const cron = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(schedule.trim());
  if (cron) {
    const minute = Number(cron[1]);
    const hour = Number(cron[2]);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    return `Every day at ${displayHour}:${String(minute).padStart(2, '0')} ${ampm}`;
  }
  return schedule;
}

/** "Tomorrow at 8:00 AM"-style phrasing for a timestamp. */
export function whenLabel(timestamp: number): string {
  const then = new Date(timestamp);
  const now = new Date();
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(then) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  return `${then.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}
