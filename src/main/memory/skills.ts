import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EmbeddingConfig } from './embeddings';
import { redactSecrets } from './redact';
import { SKILLS_NAMESPACE, indexText } from './rag';
import type { VectorStore } from './vectorStore';

interface PatternTrackerEntry {
  count: number;
  objective: string;
  toolSequence: string[];
}

type PatternTracker = Record<string, PatternTrackerEntry>;

function signatureFor(objective: string, toolSequence: string[]): string {
  const normalizedObjective = objective.toLowerCase().trim().split(/\s+/).slice(0, 6).join(' ');
  return createHash('sha256').update(`${normalizedObjective}|${toolSequence.join(',')}`).digest('hex');
}

async function loadTracker(trackerPath: string): Promise<PatternTracker> {
  try {
    return JSON.parse(await readFile(trackerPath, 'utf8')) as PatternTracker;
  } catch {
    return {};
  }
}

async function saveTracker(trackerPath: string, tracker: PatternTracker): Promise<void> {
  await mkdir(dirname(trackerPath), { recursive: true });
  await writeFile(trackerPath, JSON.stringify(tracker, null, 2), { mode: 0o600 });
}

function buildSkillMarkdown(objective: string, toolSequence: string[]): string {
  return [
    `# Skill: ${objective.slice(0, 80)}`,
    '',
    '## When to use',
    `Use this when the objective is similar to: "${objective}"`,
    '',
    '## Steps',
    ...toolSequence.map((tool, i) => `${i + 1}. ${tool}`),
    '',
    '## Pitfalls',
    'None recorded yet.',
  ].join('\n');
}

export interface RecordPatternOptions {
  skillsDir: string;
  trackerPath: string;
  store: VectorStore;
  embeddingConfig?: EmbeddingConfig;
}

export interface RecordPatternResult {
  synthesized: boolean;
  slug?: string;
}

/**
 * Tracks successful run patterns (objective + tool sequence) across the app's lifetime
 * (persisted, so it survives restarts) and synthesizes a SKILL.md the second time the same
 * pattern succeeds (PLAN.md §8 item 3). The skill is then RAG-indexed so future objectives
 * can retrieve it.
 */
export async function recordSuccessfulPattern(
  objective: string,
  toolSequence: string[],
  options: RecordPatternOptions,
): Promise<RecordPatternResult> {
  if (toolSequence.length === 0) return { synthesized: false };

  const signature = signatureFor(objective, toolSequence);
  const tracker = await loadTracker(options.trackerPath);
  const count = (tracker[signature]?.count ?? 0) + 1;
  tracker[signature] = { count, objective, toolSequence };
  await saveTracker(options.trackerPath, tracker);

  if (count < 2) return { synthesized: false };

  const slug = signature.slice(0, 16);
  const skillMarkdown = redactSecrets(buildSkillMarkdown(objective, toolSequence));
  const skillDir = join(options.skillsDir, slug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), skillMarkdown, { mode: 0o600 });

  await indexText(
    options.store,
    SKILLS_NAMESPACE,
    skillMarkdown,
    { type: 'skill', slug, objective: objective.slice(0, 200) },
    { embeddingConfig: options.embeddingConfig },
  );

  return { synthesized: true, slug };
}
