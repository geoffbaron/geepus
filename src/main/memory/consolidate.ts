import type { VectorStore } from './vectorStore';

export interface ConsolidationReport {
  namespace: string;
  duplicatesRemoved: number;
}

/**
 * Nightly consolidation (PLAN.md §8 item 5) — the prototype never did this and its stores
 * grew unbounded. Scheduling this to actually run nightly is M5's job (scheduler.ts); this
 * is the function it will call. Currently: dedupe exact-text duplicates per namespace.
 * (Per-namespace size capping and oldest-eviction already happen on every write in
 * VectorStore.add — this is the sweep for what accumulates between writes.)
 */
export async function consolidateAll(store: VectorStore): Promise<ConsolidationReport[]> {
  const namespaces = await store.listNamespaces();
  const reports: ConsolidationReport[] = [];
  for (const namespace of namespaces) {
    const duplicatesRemoved = await store.dedupe(namespace);
    reports.push({ namespace, duplicatesRemoved });
  }
  return reports;
}
