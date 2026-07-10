// Confirms every MODEL_CATALOG entry's ollamaTag actually exists in the Ollama
// registry, so the catalog never drifts into speculative/unreleased tags
// (see PLAN.md §10 — the prototype's ollama-manager.js catalog was never checked).
import { MODEL_CATALOG } from '../src/main/models/catalog.ts';

async function tagExists(tag: string): Promise<boolean> {
  const [name, ver] = tag.split(':');
  const url = `https://registry.ollama.ai/v2/library/${name}/manifests/${ver}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
  });
  return res.ok;
}

let failed = false;
for (const entry of MODEL_CATALOG) {
  const ok = await tagExists(entry.ollamaTag);
  console.log(`${ok ? '✓' : '✗'} ${entry.ollamaTag}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('\nOne or more catalog entries do not exist in the Ollama registry.');
  process.exit(1);
}
console.log('\nAll catalog entries verified.');
