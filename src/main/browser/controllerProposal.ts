import type { ToolCall } from '@shared/model';
import type { ToolResult } from '@shared/agent';
import type { PlaybookStep } from '@shared/browser';
import { inferIntentTags, saveProposedBrowserControllerSpec } from './controllerRegistry';

export interface ProposeControllerOptions {
  objective: string;
  workspaceRoot: string;
  calls: Array<{ call: ToolCall; result: ToolResult }>;
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * After a successful 'browse' run, turns the sequence of browser tool calls into a
 * proposed controller spec — "successful site flows become replayable playbooks"
 * (PLAN.md §7 item 5). Proposed only, never auto-promoted to active (PLAN.md §8 item 4:
 * promotion happens after a verified successful replay, which is a human/future-run
 * decision, not something this function does on its own).
 */
export async function proposeBrowserControllerIfApplicable(options: ProposeControllerOptions): Promise<string | null> {
  const browserCalls = options.calls.filter((c) => c.call.name.startsWith('browser_') && c.result.ok);
  const gotoCall = browserCalls.find((c) => c.call.name === 'browser_goto');
  if (!gotoCall) return null;

  const url = String(parseArgs(gotoCall.call)['url'] ?? '');
  const domain = extractDomain(url);
  if (!domain) return null;

  // Require at least one real interaction beyond navigation/observation to be worth proposing.
  const interactionCalls = browserCalls.filter(
    (c) => !['browser_goto', 'browser_read', 'browser_find'].includes(c.call.name),
  );
  if (interactionCalls.length === 0) return null;

  const steps: PlaybookStep[] = browserCalls.map((c) => {
    const args = parseArgs(c.call);
    const target = args['target'] && typeof args['target'] === 'object' ? (args['target'] as Record<string, unknown>) : {};
    return {
      kind: 'browser',
      action: c.call.name.replace(/^browser_/, ''),
      targetText: String(target['text'] ?? args['url'] ?? args['text'] ?? ''),
      targetLabel: String(target['label'] ?? ''),
      url: String(args['url'] ?? ''),
      requiresTexts: [],
    };
  });

  const spec = {
    version: 1,
    id: `${domain}-${Date.now()}`,
    name: `${domain}: ${options.objective.slice(0, 60)}`,
    match: { domains: [domain], intents: inferIntentTags(options.objective) },
    route: { preferredEntryUrls: [url], fallbackEntryUrls: [], linkTextPriority: [] },
    playbook: { steps },
  };

  try {
    return await saveProposedBrowserControllerSpec(options.workspaceRoot, spec);
  } catch {
    return null;
  }
}
