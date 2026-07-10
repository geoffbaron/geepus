// Not run in CI (no fetch mocking — hits whatever's actually on the dev machine).
// Kept as a manual sanity check; run with `npx vitest run discovery.live.test.ts`.
import { describe, expect, it } from 'vitest';
import { discoverRuntimes } from './discovery';

describe.skipIf(!process.env['GEEPUS_LIVE_TESTS'])('discoverRuntimes (live)', () => {
  it('reflects the real Ollama server on this machine', async () => {
    const report = await discoverRuntimes();
    console.log(JSON.stringify(report, null, 2));
    const ollama = report.runtimes.find((r) => r.id === 'ollama');
    expect(ollama?.available).toBe(true);
    expect(ollama?.models.length).toBeGreaterThan(0);
  });
});
