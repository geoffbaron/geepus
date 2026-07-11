import type { MemoryService } from '../memory/service';

export interface Suggestion {
  text: string;
  /** Seeds a one-tap run via runtime.run(). */
  objective: string;
}

/**
 * Mines the RUNS_NAMESPACE (indexed by MemoryService.recordRunOutcome — see M4) for
 * failed objectives worth retrying. Deliberately simple and heuristic, matching the
 * plan's "mines memory ... to propose 3-5 next actions" (PLAN.md §7 item 4) — this isn't
 * meant to be clever, just surface stalled work the user might have forgotten about.
 */
export async function generateSuggestions(memory: MemoryService, limit = 5): Promise<Suggestion[]> {
  const hits = await memory.recall('objective outcome run failed', undefined, limit * 4);
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];

  for (const hit of hits) {
    const objectiveMatch = hit.text.match(/^Objective: (.+)$/m);
    const outcomeMatch = hit.text.match(/^Outcome: (\w+)$/m);
    if (!objectiveMatch || outcomeMatch?.[1] !== 'failed') continue;

    const objective = objectiveMatch[1]!.trim();
    if (seen.has(objective)) continue;
    seen.add(objective);

    suggestions.push({ text: `Retry: ${objective}`, objective });
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}
