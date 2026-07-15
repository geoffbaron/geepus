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
import type { OpenCalendarFileResult, OpenMailDraftResult } from './handoff';
import type { WebmailConnectionStatus, WebmailProviderId, WebmailProviderInfo } from './webmail';
import type { UpdateStatus } from './update';

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
  handoff: {
    /** Opens the user's default mail client with a draft prefilled. Never sends anything. */
    openMailDraft: (draft: { to?: string; subject: string; body: string }) => Promise<OpenMailDraftResult>;
    /** Opens a Geepus-generated .ics file in the user's default calendar app. */
    openCalendarFile: (path: string) => Promise<OpenCalendarFileResult>;
  };
  webmail: {
    listProviders: () => Promise<WebmailProviderInfo[]>;
    /** Opens a real, visible sign-in window for the user to complete themselves. */
    connect: (providerId: WebmailProviderId) => Promise<void>;
    /** Navigates the Geepus Browser to the inbox and checks whether it's signed in yet. */
    checkStatus: (providerId: WebmailProviderId) => Promise<WebmailConnectionStatus>;
    /** Last-known connection state from settings — no browser round-trip. */
    getStatus: () => Promise<WebmailConnectionStatus>;
    /** Closes the session and deletes the browser profile entirely. */
    disconnect: () => Promise<void>;
    runInboxNow: () => Promise<InboxRunResult>;
  };
  updates: {
    getStatus: () => Promise<UpdateStatus>;
    /** Manual "check now" — for a Settings button. Auto-check already runs on launch. */
    check: () => Promise<void>;
    /** Quit and apply the already-downloaded update. Only meaningful after 'ready'. */
    installNow: () => Promise<void>;
    onStatus: (onStatus: (status: UpdateStatus) => void) => () => void;
  };
}

export type IpcNamespace = keyof IpcApi;
export type IpcChannel = {
  [N in IpcNamespace]: `${N}.${string & keyof IpcApi[N]}`;
}[IpcNamespace];
