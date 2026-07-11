/**
 * The IPC contract shared by main, preload, and renderer.
 *
 * Namespaced channels (`app.*`, `setup.*`, `chat.*`, ...) keep this file the single source of
 * truth instead of 78 flat strings — see PLAN.md §10 (do not repeat ipc-handlers.js's mistake).
 * Each milestone adds its own namespace here and a matching module under src/main/ipc/.
 */

import type { ChatChunk, ChatRequest, OllamaPullProgress, ProviderStatus } from './model';
import type { Settings } from './settings';
import type { DiscoveryReport, InstallOllamaResult, MachineProfile, Recommendation, SetupPlan } from './setup';
import type { AgentEvent, PendingApproval, RunRequest } from './agent';
import type { ConsolidationReport, MemoryEntry } from './memory';
import type { FileWatchTrigger, FileWatchTriggerInput, ScheduledTask, ScheduledTaskInput } from './schedule';
import type { ImapConnectionTestResult, InboxRunResult, MailAccountInput } from './mail';
import type { DailyBrief } from './brief';
import type { ProposedControllerSpec } from './browser';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export interface IpcApi {
  app: {
    getVersion: () => Promise<string>;
    /** Opens a help page in the user's real browser. Main enforces a strict URL
     * allowlist (mail app-password pages only) — returns false for anything else. */
    openHelpLink: (url: string) => Promise<boolean>;
  };
  models: {
    listProviders: () => Promise<ProviderStatus[]>;
    /** Streams chunks via onChunk as they arrive; returns an unsubscribe function. */
    chat: (request: ChatRequest, onChunk: (chunk: ChatChunk) => void) => () => void;
    onBundledDownloadProgress: (onProgress: (progress: DownloadProgress) => void) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    update: (partial: Partial<Settings>) => Promise<Settings>;
  };
  setup: {
    probeHardware: () => Promise<MachineProfile>;
    discover: () => Promise<DiscoveryReport>;
    recommend: (profile: MachineProfile) => Promise<Recommendation>;
    determinePath: (profile: MachineProfile, discovery: DiscoveryReport) => Promise<SetupPlan>;
    adoptOllamaModel: (modelName: string) => Promise<Settings>;
    useBundled: () => Promise<Settings>;
    pullModel: (tag: string, onProgress: (progress: OllamaPullProgress) => void) => () => void;
    installOllama: (onProgress: (progress: DownloadProgress) => void) => Promise<InstallOllamaResult>;
    launchOllama: () => Promise<boolean>;
    requestNotificationPermission: () => Promise<boolean>;
    completeOnboarding: () => Promise<Settings>;
  };
  runtime: {
    /** Streams events via onEvent as they arrive; returns an unsubscribe function. */
    run: (request: RunRequest, onEvent: (event: AgentEvent) => void) => () => void;
    listPendingApprovals: () => Promise<PendingApproval[]>;
    resolveApproval: (id: string, approved: boolean) => Promise<boolean>;
    onApprovalRequested: (onApproval: (approval: PendingApproval) => void) => () => void;
  };
  memory: {
    listEntries: () => Promise<MemoryEntry[]>;
    remember: (text: string) => Promise<void>;
    forget: (namespace: string, id: string) => Promise<boolean>;
    consolidate: () => Promise<ConsolidationReport[]>;
  };
  schedule: {
    list: () => Promise<ScheduledTask[]>;
    add: (input: ScheduledTaskInput) => Promise<ScheduledTask>;
    update: (id: string, patch: Partial<ScheduledTaskInput>) => Promise<ScheduledTask>;
    remove: (id: string) => Promise<ScheduledTask>;
    runNow: (id: string) => Promise<ScheduledTask>;
    listTriggers: () => Promise<FileWatchTrigger[]>;
    addTrigger: (input: FileWatchTriggerInput) => Promise<FileWatchTrigger>;
    removeTrigger: (id: string) => Promise<FileWatchTrigger>;
  };
  mail: {
    testConnection: (config: MailAccountInput) => Promise<ImapConnectionTestResult>;
    saveAccount: (config: MailAccountInput) => Promise<void>;
    isConfigured: () => Promise<boolean>;
    runInboxNow: () => Promise<InboxRunResult>;
  };
  brief: {
    generate: () => Promise<DailyBrief>;
  };
  browser: {
    listProposedControllers: (workspaceRoot?: string) => Promise<ProposedControllerSpec[]>;
    promoteController: (specId: string, workspaceRoot?: string) => Promise<string>;
  };
}

export type IpcNamespace = keyof IpcApi;
export type IpcChannel = {
  [N in IpcNamespace]: `${N}.${string & keyof IpcApi[N]}`;
}[IpcNamespace];
