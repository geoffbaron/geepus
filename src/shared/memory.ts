export interface MemoryEntry {
  namespace: string;
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ConsolidationReport {
  namespace: string;
  duplicatesRemoved: number;
}
