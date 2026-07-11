import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inferIntentTags,
  listProposedBrowserControllerSpecs,
  loadBrowserControllerSpecsSync,
  pickMatchingBrowserControllerSpec,
  promoteProposedBrowserControllerSpec,
  saveProposedBrowserControllerSpec,
  validateBrowserControllerSpec,
} from './controllerRegistry';
import type { BrowserControllerSpec } from '@shared/browser';

function validSpec(overrides: Partial<BrowserControllerSpec> = {}): BrowserControllerSpec {
  return {
    version: 1,
    id: 'example-signup',
    name: 'Example.com signup',
    match: { domains: ['example.com'], intents: ['signup'] },
    route: { preferredEntryUrls: ['https://example.com/signup'], fallbackEntryUrls: [], linkTextPriority: [] },
    playbook: { steps: [{ kind: 'browser', action: 'click', targetText: 'Sign up', targetLabel: '', url: '', requiresTexts: [] }] },
    ...overrides,
  };
}

describe('validateBrowserControllerSpec', () => {
  it('accepts a well-formed spec', () => {
    const result = validateBrowserControllerSpec(validSpec());
    expect(result.ok).toBe(true);
    expect(result.spec?.id).toBe('example-signup');
  });

  it('rejects a non-object', () => {
    expect(validateBrowserControllerSpec('not an object').ok).toBe(false);
    expect(validateBrowserControllerSpec(null).ok).toBe(false);
  });

  it('requires an id and name', () => {
    const noId = validateBrowserControllerSpec({ ...validSpec(), id: '' });
    expect(noId.ok).toBe(false);
    expect(noId.errors.some((e) => /id/.test(e))).toBe(true);
  });

  it('requires at least one domain', () => {
    const result = validateBrowserControllerSpec({ ...validSpec(), match: { domains: [], intents: [] } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /domain/.test(e))).toBe(true);
  });

  it('rejects the wrong version', () => {
    expect(validateBrowserControllerSpec({ ...validSpec(), version: 99 }).ok).toBe(false);
  });

  it('drops playbook steps missing a kind or action', () => {
    const result = validateBrowserControllerSpec({
      ...validSpec(),
      playbook: { steps: [{ kind: 'browser', action: 'click' }, { kind: '', action: 'click' }, { action: 'no-kind' }] },
    });
    expect(result.spec?.playbook.steps).toHaveLength(1);
  });
});

describe('inferIntentTags', () => {
  it.each([
    ['sign up for the newsletter', 'signup'],
    ['log in to my account', 'login'],
    ['verify my email address', 'verification'],
    ['checkout and place order', 'checkout'],
    ['book an appointment', 'booking'],
    ['finish setup', 'onboarding'],
    ['export the report as csv', 'export'],
  ])('%s -> includes %s', (objective, expectedTag) => {
    expect(inferIntentTags(objective)).toContain(expectedTag);
  });

  it('detects "create an account" as signup even without the word signup', () => {
    expect(inferIntentTags('create an account on this site')).toContain('signup');
  });

  it('returns an empty array for an objective with no recognizable intent', () => {
    expect(inferIntentTags('look at the homepage')).toEqual([]);
  });
});

describe('pickMatchingBrowserControllerSpec', () => {
  const signupSpec = validSpec({ id: 'signup', match: { domains: ['example.com'], intents: ['signup'] } });
  const loginSpec = validSpec({ id: 'login', match: { domains: ['example.com'], intents: ['login'] } });
  const genericSpec = validSpec({ id: 'generic', match: { domains: ['other.com'], intents: [] } });

  it('picks the spec matching both domain and intent', () => {
    const result = pickMatchingBrowserControllerSpec([signupSpec, loginSpec], { objective: 'sign up for an account', domain: 'example.com' });
    expect(result?.id).toBe('signup');
  });

  it('a spec with no intents matches any objective for its domain', () => {
    const result = pickMatchingBrowserControllerSpec([genericSpec], { objective: 'anything at all', domain: 'other.com' });
    expect(result?.id).toBe('generic');
  });

  it('returns null when no domain matches', () => {
    expect(pickMatchingBrowserControllerSpec([signupSpec], { objective: 'sign up', domain: 'nomatch.com' })).toBeNull();
  });

  it('ignores www. prefix when matching domains', () => {
    const result = pickMatchingBrowserControllerSpec([signupSpec], { objective: 'sign up', domain: 'www.example.com' });
    expect(result?.id).toBe('signup');
  });
});

describe('file-backed registry operations', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-controller-registry-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('saves a proposed spec and it is listable', async () => {
    const spec = validSpec();
    const file = await saveProposedBrowserControllerSpec(workspaceRoot, spec);
    expect(file).toContain('proposed');

    const proposed = await listProposedBrowserControllerSpecs(workspaceRoot);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.id).toBe(spec.id);
    expect(proposed[0]?.ok).toBe(true);
  });

  it('rejects saving an invalid spec', async () => {
    await expect(saveProposedBrowserControllerSpec(workspaceRoot, { id: '' })).rejects.toThrow(/invalid/i);
  });

  it('promotes a proposed spec to active, and it is then loadable', async () => {
    const spec = validSpec();
    await saveProposedBrowserControllerSpec(workspaceRoot, spec);
    const activePath = await promoteProposedBrowserControllerSpec(workspaceRoot, spec.id);
    expect(activePath).toContain('active');

    const loaded = loadBrowserControllerSpecsSync(workspaceRoot);
    expect(loaded.some((s) => s.id === spec.id)).toBe(true);

    // Promotion removes it from proposed.
    const stillProposed = await listProposedBrowserControllerSpecs(workspaceRoot);
    expect(stillProposed).toHaveLength(0);
  });

  it('throws when promoting a spec that was never proposed', async () => {
    await expect(promoteProposedBrowserControllerSpec(workspaceRoot, 'never-proposed')).rejects.toThrow();
  });

  it('loadBrowserControllerSpecsSync returns an empty array when nothing has been saved', () => {
    expect(loadBrowserControllerSpecsSync(workspaceRoot)).toEqual([]);
  });

  it('listProposedBrowserControllerSpecs returns an empty array for an empty workspace', async () => {
    expect(await listProposedBrowserControllerSpecs(workspaceRoot)).toEqual([]);
  });
});
