import type { BrowserControllerSpec, PlaybookStep } from '@shared/browser';
import type { BrowserSession } from './session';

export interface ReplayStepResult {
  step: PlaybookStep;
  ok: boolean;
  detail: string;
}

export interface ReplayResult {
  specId: string;
  ok: boolean;
  steps: ReplayStepResult[];
}

/**
 * Executes a controller spec's recorded playbook against a live BrowserSession — this is
 * what makes a proposed spec an actual "replayable playbook" (PLAN.md §7 item 5), not just
 * a saved JSON record. Stops at the first failing step; everything before it already ran.
 */
export async function replayControllerSpec(spec: BrowserControllerSpec, session: BrowserSession): Promise<ReplayResult> {
  const results: ReplayStepResult[] = [];

  for (const step of spec.playbook.steps) {
    try {
      switch (step.action) {
        case 'goto': {
          const url = step.url || spec.route.preferredEntryUrls[0] || '';
          if (!url) throw new Error('goto step has no URL to navigate to');
          await session.goto(url);
          break;
        }
        case 'click':
          await session.click(targetFor(step));
          break;
        case 'type':
          await session.type(targetFor(step), step.targetText);
          break;
        case 'select':
          await session.selectOption(targetFor(step), step.targetText);
          break;
        case 'wait_for':
          await session.waitFor({ text: step.targetText || undefined });
          break;
        case 'scroll':
          await session.scroll('down');
          break;
        case 'read':
        case 'find':
          await session.read();
          break;
        default:
          throw new Error(`unknown playbook step action: ${step.action}`);
      }
      results.push({ step, ok: true, detail: 'ok' });
    } catch (err) {
      results.push({ step, ok: false, detail: (err as Error).message });
      return { specId: spec.id, ok: false, steps: results };
    }
  }

  return { specId: spec.id, ok: true, steps: results };
}

function targetFor(step: PlaybookStep): { text?: string; label?: string } {
  return { text: step.targetText || undefined, label: step.targetLabel || undefined };
}
