// Not run in CI — hits the real Ollama server on the dev machine. Run with:
// GEEPUS_LIVE_TESTS=1 npx vitest run loop.live.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runObjective } from './loop';
import { OllamaProvider } from '../models/ollama';
import type { AgentEvent } from '@shared/agent';

describe.skipIf(!process.env['GEEPUS_LIVE_TESTS'])('runObjective (live, real Ollama)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'geepus-loop-live-test-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // NOTE ON SCOPE: a 1B-parameter model is unreliable about actually invoking native tool
  // calls (observed live: sometimes it calls http_get correctly, sometimes it emits the
  // call shape as plain text instead, sometimes it just answers from its own knowledge) —
  // that's a small-model capability limitation, not something this runtime controls, and
  // exactly the kind of gap the plan's "strict-JSON fallback" follow-up is meant to close.
  // What THIS test asserts is the actual bug-fix contract: the historical failure was an
  // infinite loop (classified as 'build', demanding verification a lookup could never
  // produce). That must not happen regardless of whether the tiny model chooses to call
  // the tool — the run must classify correctly and finish inside the iteration budget
  // either way. loop.test.ts (scripted, deterministic) separately proves the tool-call
  // execution wiring itself is correct whenever a provider does emit a tool_call.
  it(
    'the canonical investigation scenario: "check the weather" never loops/deadlocks against a real model',
    async () => {
      const provider = new OllamaProvider({ model: 'llama3.2:1b' });
      const events: AgentEvent[] = [];
      for await (const event of runObjective({
        objective:
          'Call the http_get tool right now with url set to exactly ' +
          '"https://api.open-meteo.com/v1/forecast?latitude=48.9971&longitude=-122.7472&current=temperature_2m,weather_code" ' +
          'to check the current weather in Blaine, WA. Do not answer from your own knowledge — call the tool first.',
        workspaceRoot,
        provider,
        budgets: { maxIterations: 5 },
      })) {
        events.push(event);
        console.log(JSON.stringify(event).slice(0, 200));
      }

      const classified = events.find((e) => e.type === 'classified') as { taskClass: string };
      expect(classified.taskClass).toBe('lookup');

      const done = events.find((e) => e.type === 'done') as { success: boolean; reason: string };
      expect(done.success).toBe(true);

      const iterationCount = events.filter((e) => e.type === 'iteration_start').length;
      expect(iterationCount).toBeLessThanOrEqual(5);
    },
    60_000,
  );
});
