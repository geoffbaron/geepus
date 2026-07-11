/**
 * Cron-lite parser ported from the prototype's scheduler.js — minute/hour/day-of-month/
 * month/day-of-week fields, each supporting "*", comma-lists, ranges, and step syntax
 * (e.g. every-15 written as star-slash-15). Plus a simple "every Nm/h/d" interval syntax
 * the prototype also supported.
 */

export interface ParsedCron {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null;
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(?:\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] !== undefined ? Number(stepMatch[1]) : min;
      const end = stepMatch[2] !== undefined ? Number(stepMatch[2]) : max;
      const step = Number(stepMatch[3]) || 1;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }
    const num = Number(part);
    if (Number.isFinite(num) && num >= min && num <= max) values.add(num);
  }

  return values.size > 0 ? values : null;
}

export function parseCron(expression: string): ParsedCron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return null;
  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: parseCronField(parts[4]!, 0, 6),
  };
}

export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (parsed.minute && !parsed.minute.has(date.getMinutes())) return false;
  if (parsed.hour && !parsed.hour.has(date.getHours())) return false;
  if (parsed.dayOfMonth && !parsed.dayOfMonth.has(date.getDate())) return false;
  if (parsed.month && !parsed.month.has(date.getMonth() + 1)) return false;
  if (parsed.dayOfWeek && !parsed.dayOfWeek.has(date.getDay())) return false;
  return true;
}

/** "every 30m" / "every 2h" / "every 1d" -> milliseconds, or 0 if it doesn't match. */
export function parseInterval(expression: string): number {
  const match = expression.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith('m')) return amount * 60 * 1000;
  if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
  if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
  return 0;
}

/** Walks forward minute-by-minute (up to 48h) to find the next cron match. */
export function nextCronMatch(expression: string, from: Date): Date | null {
  const parsed = parseCron(expression);
  if (!parsed) return null;

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxLookaheadMinutes = 48 * 60;
  for (let i = 0; i < maxLookaheadMinutes; i++) {
    if (cronMatches(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
