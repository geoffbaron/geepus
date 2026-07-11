import { join } from 'node:path';
import type { EmbeddingConfig } from './embeddings';
import { GLOBAL_NAMESPACE, RUNS_NAMESPACE, SKILLS_NAMESPACE, indexText, retrieveContext, toRagPrompt, workspaceNamespace } from './rag';
import { getRelevantStrategies, recordStrategyOutcome } from './strategies';
import { recordSuccessfulPattern } from './skills';
import { consolidateAll } from './consolidate';
import { VectorStore } from './vectorStore';

export interface MemoryServiceConfig {
  /** e.g. userData/memory */
  dataDir: string;
  embeddingConfig?: EmbeddingConfig;
}

export interface RecordRunOutcomeOptions {
  objective: string;
  workspaceRoot: string;
  success: boolean;
  reflection?: string;
  toolSequence: string[];
}

/** Ties embeddings + vector store + RAG + strategies + skills together — the single
 * entry point the AgentRuntime talks to (PLAN.md §8). */
export class MemoryService {
  readonly store: VectorStore;
  private readonly dataDir: string;
  private readonly embeddingConfig?: EmbeddingConfig;

  constructor(config: MemoryServiceConfig) {
    this.dataDir = config.dataDir;
    this.embeddingConfig = config.embeddingConfig;
    this.store = new VectorStore(join(this.dataDir, 'vectors'));
  }

  get skillsDir(): string {
    return join(this.dataDir, 'skills');
  }

  private get trackerPath(): string {
    return join(this.dataDir, 'pattern-tracker.json');
  }

  async remember(text: string, workspaceRoot?: string): Promise<void> {
    const namespace = workspaceRoot ? workspaceNamespace(workspaceRoot) : GLOBAL_NAMESPACE;
    await indexText(this.store, namespace, text, { type: 'note', workspaceRoot: workspaceRoot ?? null }, {
      embeddingConfig: this.embeddingConfig,
    });
  }

  async recall(query: string, workspaceRoot?: string, topK = 5) {
    const namespaces = [GLOBAL_NAMESPACE, RUNS_NAMESPACE];
    if (workspaceRoot) namespaces.unshift(workspaceNamespace(workspaceRoot));
    return retrieveContext(this.store, query, namespaces, { topK, embeddingConfig: this.embeddingConfig });
  }

  async recallPrompt(query: string, workspaceRoot?: string, topK = 5): Promise<string> {
    return toRagPrompt(await this.recall(query, workspaceRoot, topK));
  }

  /** Called once at the end of a run: indexes a run summary, folds the reflection into
   * learned strategies, and — on success — checks whether this is the 2nd time this
   * exact pattern has succeeded, synthesizing a skill if so. */
  async recordRunOutcome(options: RecordRunOutcomeOptions): Promise<{ skillSynthesized: boolean }> {
    const summaryLines = [
      `Objective: ${options.objective}`,
      `Outcome: ${options.success ? 'success' : 'failed'}`,
    ];
    if (options.reflection) summaryLines.push(`Reflection: ${options.reflection}`);

    await indexText(
      this.store,
      RUNS_NAMESPACE,
      summaryLines.join('\n'),
      { type: 'run_summary', workspaceRoot: options.workspaceRoot, success: options.success },
      { embeddingConfig: this.embeddingConfig },
    );

    if (options.reflection && !/nothing notable/i.test(options.reflection)) {
      await recordStrategyOutcome(this.store, options.reflection, options.success, this.embeddingConfig);
    }

    let skillSynthesized = false;
    if (options.success) {
      const result = await recordSuccessfulPattern(options.objective, options.toolSequence, {
        skillsDir: this.skillsDir,
        trackerPath: this.trackerPath,
        store: this.store,
        embeddingConfig: this.embeddingConfig,
      });
      skillSynthesized = result.synthesized;
    }

    return { skillSynthesized };
  }

  /** What the planner prompt gets: relevant learned strategies + relevant skills, formatted
   * for direct inclusion in a system prompt. */
  async getPromptContext(objective: string, topK = 3): Promise<string> {
    const [strategies, skillHits] = await Promise.all([
      getRelevantStrategies(this.store, objective, topK, this.embeddingConfig),
      retrieveContext(this.store, objective, [SKILLS_NAMESPACE], { topK, embeddingConfig: this.embeddingConfig }),
    ]);

    const parts: string[] = [];
    if (strategies.length > 0) {
      parts.push(
        `Learned strategies:\n${strategies.map((s) => `- ${s.text} (succeeded ${s.successes}/${s.attempts} times)`).join('\n')}`,
      );
    }
    if (skillHits.length > 0) {
      parts.push(`Relevant skills:\n${skillHits.map((h) => `- ${h.text.slice(0, 300)}`).join('\n')}`);
    }
    return parts.join('\n\n');
  }

  async consolidate() {
    return consolidateAll(this.store);
  }
}
