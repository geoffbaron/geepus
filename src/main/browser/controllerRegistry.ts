import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserControllerSpec, PlaybookStep, ProposedControllerSpec } from '@shared/browser';
import { CONTROLLER_SPEC_VERSION } from '@shared/browser';

const CONTROLLER_SPEC_DIR = join('.geepus', 'browser-controllers');
const CONTROLLER_PROPOSED_SUBDIR = join(CONTROLLER_SPEC_DIR, 'proposed');
const CONTROLLER_ACTIVE_SUBDIR = join(CONTROLLER_SPEC_DIR, 'active');

function normalizeStringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizePlaybookSteps(value: unknown): PlaybookStep[] {
  return (Array.isArray(value) ? value : [])
    .map((item): PlaybookStep => {
      const step = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        kind: String(step['kind'] ?? '').trim(),
        action: String(step['action'] ?? '').trim(),
        targetText: String(step['targetText'] ?? '').trim(),
        targetLabel: String(step['targetLabel'] ?? '').trim(),
        url: String(step['url'] ?? '').trim(),
        requiresTexts: normalizeStringArray(step['requiresTexts']),
      };
    })
    .filter((step) => step.kind && step.action);
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  spec: BrowserControllerSpec | null;
}

/** Ported from the prototype's browser-controller-registry.js, near as-is (PLAN.md §10). */
export function validateBrowserControllerSpec(spec: unknown): SpecValidation {
  const errors: string[] = [];
  const value = spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : null;
  if (!value) return { ok: false, errors: ['Spec must be an object.'], spec: null };

  if (Number(value['version']) !== CONTROLLER_SPEC_VERSION) errors.push(`version must be ${CONTROLLER_SPEC_VERSION}.`);
  if (!String(value['id'] ?? '').trim()) errors.push('id is required.');
  if (!String(value['name'] ?? '').trim()) errors.push('name is required.');

  const match = value['match'] && typeof value['match'] === 'object' ? (value['match'] as Record<string, unknown>) : {};
  const domains = normalizeStringArray(match['domains']);
  if (domains.length === 0) errors.push('match.domains must include at least one domain.');

  const route = value['route'] && typeof value['route'] === 'object' ? (value['route'] as Record<string, unknown>) : {};
  const playbook = value['playbook'] && typeof value['playbook'] === 'object' ? (value['playbook'] as Record<string, unknown>) : {};

  const normalizedSpec: BrowserControllerSpec = {
    version: CONTROLLER_SPEC_VERSION,
    id: String(value['id'] ?? '').trim(),
    name: String(value['name'] ?? '').trim(),
    match: { domains, intents: normalizeStringArray(match['intents']).map((s) => s.toLowerCase()) },
    route: {
      preferredEntryUrls: normalizeStringArray(route['preferredEntryUrls']),
      fallbackEntryUrls: normalizeStringArray(route['fallbackEntryUrls']),
      linkTextPriority: normalizeStringArray(route['linkTextPriority']),
    },
    playbook: { steps: normalizePlaybookSteps(playbook['steps']) },
  };

  return { ok: errors.length === 0, errors, spec: errors.length === 0 ? normalizedSpec : null };
}

/** Sync on purpose — called once per run to build the planner's available-playbooks context,
 * matching the prototype's usage pattern. */
export function loadBrowserControllerSpecsSync(workspaceRoot: string): BrowserControllerSpec[] {
  const root = workspaceRoot.trim();
  if (!root) return [];
  const candidateDirs = [...new Set([join(root, CONTROLLER_SPEC_DIR), join(root, CONTROLLER_ACTIVE_SUBDIR)])];
  const specs: BrowserControllerSpec[] = [];

  for (const specDir of candidateDirs) {
    if (!existsSync(specDir)) continue;
    for (const entry of readdirSync(specDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = join(specDir, entry.name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(fullPath, 'utf8'));
        const validation = validateBrowserControllerSpec(parsed);
        if (validation.ok && validation.spec) specs.push({ ...validation.spec, sourcePath: fullPath });
      } catch {
        // Malformed specs are user-extensible artifacts — skip rather than crash the run.
      }
    }
  }
  return specs;
}

const INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sign.?up|signup|register)\b/, 'signup'],
  [/\b(log.?in|login|sign.?in|signin)\b/, 'login'],
  [/\b(verify|verification|confirm email|check inbox)\b/, 'verification'],
  [/\b(checkout|place order|submit order|pay now|purchase|buy)\b/, 'checkout'],
  [/\b(book|booking|reserve|reservation|schedule|appointment|demo)\b/, 'booking'],
  [/\b(onboarding|onboard|finish setup|complete setup|get started|welcome flow)\b/, 'onboarding'],
  [/\b(export|download|csv|pdf|report|statement)\b/, 'export'],
];

export function inferIntentTags(objective: string): string[] {
  const lower = objective.toLowerCase();
  const tags: string[] = [];
  for (const [pattern, tag] of INTENT_PATTERNS) {
    if (pattern.test(lower)) tags.push(tag);
  }
  // "create an account" doesn't match the signup regex directly — mirror the prototype's
  // separate compound check for that phrasing.
  if (/\bcreate\b/.test(lower) && /\baccount\b/.test(lower) && !tags.includes('signup')) tags.push('signup');
  return tags;
}

export function pickMatchingBrowserControllerSpec(
  specs: BrowserControllerSpec[],
  options: { objective?: string; domain?: string } = {},
): BrowserControllerSpec | null {
  const intentTags = inferIntentTags(options.objective ?? '');
  const normalizedDomain = (options.domain ?? '').toLowerCase().replace(/^www\./, '');

  const candidates = specs.filter((spec) => {
    const domains = spec.match.domains.map((d) => d.toLowerCase().replace(/^www\./, ''));
    if (normalizedDomain && domains.length > 0 && !domains.includes(normalizedDomain)) return false;
    const intents = spec.match.intents;
    if (intents.length === 0) return true;
    return intentTags.some((tag) => intents.includes(tag));
  });

  return candidates[0] ?? null;
}

export async function listProposedBrowserControllerSpecs(workspaceRoot: string): Promise<ProposedControllerSpec[]> {
  const root = workspaceRoot.trim();
  if (!root) return [];
  const dir = join(root, CONTROLLER_PROPOSED_SUBDIR);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const output: ProposedControllerSpec[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = join(dir, entry.name);
      try {
        const parsed: unknown = JSON.parse(await readFile(fullPath, 'utf8'));
        const validation = validateBrowserControllerSpec(parsed);
        output.push({
          ok: validation.ok,
          errors: validation.errors,
          id: validation.spec?.id ?? '',
          name: validation.spec?.name ?? '',
          match: validation.spec?.match ?? {},
          route: validation.spec?.route ?? {},
          playbook: validation.spec?.playbook ?? { steps: [] },
          sourcePath: fullPath,
        });
      } catch (error) {
        output.push({
          ok: false,
          errors: [(error as Error).message],
          id: '',
          name: '',
          match: {},
          route: {},
          playbook: { steps: [] },
          sourcePath: fullPath,
        });
      }
    }
    return output;
  } catch {
    return [];
  }
}

function safeSpecFileName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'controller-spec';
}

export async function saveProposedBrowserControllerSpec(workspaceRoot: string, spec: unknown): Promise<string> {
  const validation = validateBrowserControllerSpec(spec);
  if (!validation.ok || !validation.spec) throw new Error(`Invalid browser controller spec: ${validation.errors.join(' ')}`);
  const root = workspaceRoot.trim();
  if (!root) throw new Error('workspaceRoot is required');

  const dir = join(root, CONTROLLER_PROPOSED_SUBDIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${safeSpecFileName(validation.spec.id)}.json`);
  await writeFile(file, JSON.stringify(validation.spec, null, 2), 'utf8');
  return file;
}

/** Proposed → active promotion — only happens after a verified successful replay (PLAN.md §8 item 4). */
export async function promoteProposedBrowserControllerSpec(workspaceRoot: string, specId: string): Promise<string> {
  const root = workspaceRoot.trim();
  const id = specId.trim();
  if (!root) throw new Error('workspaceRoot is required');
  if (!id) throw new Error('specId is required');

  const proposedPath = join(root, CONTROLLER_PROPOSED_SUBDIR, `${safeSpecFileName(id)}.json`);
  const parsed: unknown = JSON.parse(await readFile(proposedPath, 'utf8'));
  const validation = validateBrowserControllerSpec(parsed);
  if (!validation.ok || !validation.spec) throw new Error(`Invalid proposed browser controller spec: ${validation.errors.join(' ')}`);

  const activeDir = join(root, CONTROLLER_ACTIVE_SUBDIR);
  await mkdir(activeDir, { recursive: true });
  const activePath = join(activeDir, `${safeSpecFileName(validation.spec.id)}.json`);
  await writeFile(activePath, JSON.stringify(validation.spec, null, 2), 'utf8');
  await unlink(proposedPath).catch(() => {});
  return activePath;
}

export { CONTROLLER_SPEC_DIR, CONTROLLER_PROPOSED_SUBDIR, CONTROLLER_ACTIVE_SUBDIR };
