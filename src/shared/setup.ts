import type { ModelCatalogEntry, RamTier } from './model';

export interface MachineProfile {
  chip: string;
  arch: string;
  ramGb: number;
  freeDiskGb: number;
  osVersion: string;
  tier: RamTier;
}

export interface DiscoveredModel {
  name: string;
  sizeGb: number;
}

export type RuntimeId = 'ollama' | 'lmstudio';

export interface DiscoveredRuntime {
  id: RuntimeId;
  available: boolean;
  binaryFound: boolean;
  models: DiscoveredModel[];
}

export interface LooseModelFile {
  path: string;
  sizeGb: number;
}

export interface DiscoveryReport {
  runtimes: DiscoveredRuntime[];
  looseFiles: LooseModelFile[];
}

/**
 * A — has Ollama + a model that fits: adopt it.
 * B — has Ollama, no suitable model: pull the recommendation.
 * C — nothing detected: install Ollama, or use the bundled brain.
 * D — under 8GB RAM: bundled brain only (PLAN.md §6.4).
 */
export type SetupPath = 'A' | 'B' | 'C' | 'D';

export interface SetupPlan {
  path: SetupPath;
  reason: string;
}

export interface Recommendation {
  chatModel: ModelCatalogEntry | null;
  embeddingModel: ModelCatalogEntry;
}

export interface SignatureCheck {
  ok: boolean;
  detail: string;
}

export interface InstallOllamaResult {
  appPath: string;
  signature: SignatureCheck;
}
