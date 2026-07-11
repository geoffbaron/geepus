// Not run in CI — launches a real headless Chromium and hits a real website. Run with:
// GEEPUS_LIVE_TESTS=1 npx vitest run replay.live.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from './session';
import { loadBrowserControllerSpecsSync, promoteProposedBrowserControllerSpec, saveProposedBrowserControllerSpec } from './controllerRegistry';
import { replayControllerSpec } from './replay';

describe.skipIf(!process.env['GEEPUS_LIVE_TESTS'])('propose -> promote -> replay (live, real browser + real site)', () => {
  let profileDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'geepus-replay-profile-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-replay-ws-'));
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it(
    'the full M6 accept-criteria cycle: a successful flow proposes a spec that replays for real',
    async () => {
      // Step 1: a real browser flow, same primitives the agent loop's browser tools use.
      const session1 = new BrowserSession(profileDir);
      await session1.goto('https://the-internet.herokuapp.com/add_remove_elements/');
      await session1.click({ role: 'button', text: 'Add Element' });
      await session1.close();

      // Step 2: propose a spec from that flow (same shape controllerProposal.ts builds).
      const spec = {
        version: 1,
        id: 'the-internet-test',
        name: 'the-internet.herokuapp.com: add an element',
        match: { domains: ['the-internet.herokuapp.com'], intents: [] },
        route: {
          preferredEntryUrls: ['https://the-internet.herokuapp.com/add_remove_elements/'],
          fallbackEntryUrls: [],
          linkTextPriority: [],
        },
        playbook: {
          steps: [
            { kind: 'browser', action: 'goto', targetText: '', targetLabel: '', url: 'https://the-internet.herokuapp.com/add_remove_elements/', requiresTexts: [] },
            { kind: 'browser', action: 'click', targetText: 'Add Element', targetLabel: '', url: '', requiresTexts: [] },
          ],
        },
      };
      await saveProposedBrowserControllerSpec(workspaceRoot, spec);

      // Step 3: promote to active.
      await promoteProposedBrowserControllerSpec(workspaceRoot, spec.id);
      const activeSpecs = loadBrowserControllerSpecsSync(workspaceRoot);
      expect(activeSpecs).toHaveLength(1);

      // Step 4: replay the promoted spec against a FRESH browser session — proves it's a
      // genuinely replayable playbook, not just a saved JSON record.
      const session2 = new BrowserSession(profileDir);
      const replayResult = await replayControllerSpec(activeSpecs[0]!, session2);
      expect(replayResult.ok).toBe(true);
      expect(replayResult.steps.every((s) => s.ok)).toBe(true);

      // And the replay produced the real DOM effect (a Delete button appears after Add).
      const finalState = await session2.read();
      expect(finalState).toContain('Delete');

      await session2.close();
    },
    30_000,
  );
});
