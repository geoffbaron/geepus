/**
 * Every write to memory/vector-store files runs through this first (wired at the
 * indexText() choke point in rag.ts) — so it's structurally impossible for a secret
 * to end up on disk, not just a matter of remembering to call it (PLAN.md §9, M4
 * accept criteria). The prototype's real settings.json on this dev machine had a live
 * Anthropic API key sitting in plaintext; this pattern set is written with that exact
 * kind of leak in mind.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-or-[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  { pattern: /Bearer\s+[A-Za-z0-9\-_.=]{10,}/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  {
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '[REDACTED_JWT]' },
  // Negative lookahead prevents this catch-all from re-matching text a more specific
  // pattern above already redacted (e.g. "token: [REDACTED_JWT]" staying that way,
  // not getting flattened to "token: [REDACTED]" by this rule running second).
  {
    pattern: /((?:api[_-]?key|apikey|password|passwd|secret|token)\s*[:=]\s*)(?!\[REDACTED)["']?[^\s"']{6,}["']?/gi,
    replacement: '$1[REDACTED]',
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
