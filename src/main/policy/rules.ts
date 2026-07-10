import type { RiskTier } from '@shared/agent';

/**
 * Patterns that are never allowed, no matter who asks — these bypass the Approvals
 * inbox entirely (PLAN.md §9). Deliberately broad: better to over-block a rare
 * legitimate use than under-block a real attack.
 */
const HARD_DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bkeychain\b/i,
  /security\s+find-generic-password/i,
  /\blaunchctl\b/i,
  /\bssh\b/i,
  /\bgit\s+push\b/i,
  /curl[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\.ssh\//,
  /\.aws\//,
  /\/dev\/tcp\//,
];

/** Vetted-safe command prefixes — auto-allowed at 'write' tier. Everything else that
 * isn't hard-denied falls to 'sensitive' (ask), never a silent reject. */
const SHELL_ALLOWLIST_PATTERNS: RegExp[] = [
  /^npm (test|run|install|ci|list|outdated)\b/,
  /^pnpm (test|run|install)\b/,
  /^yarn (test|install)\b/,
  /^git (status|diff|log|branch|add|commit)\b/,
  /^ls\b/,
  /^cat\b/,
  /^pwd$/,
  /^echo\b/,
  /^mkdir\b/,
  /^touch\b/,
  /^cp\b/,
  /^mv\b/,
];

export function isHardDenied(command: string): boolean {
  return HARD_DENY_PATTERNS.some((p) => p.test(command));
}

export function isShellAllowlisted(command: string): boolean {
  return SHELL_ALLOWLIST_PATTERNS.some((p) => p.test(command.trim()));
}

export function classifyRunCommand(command: string): RiskTier {
  if (isHardDenied(command)) return 'deny';
  if (isShellAllowlisted(command)) return 'write';
  return 'sensitive';
}

const HTTP_ALLOWLIST_DOMAINS = [
  'api.open-meteo.com',
  'wttr.in',
  'api.github.com',
  'raw.githubusercontent.com',
  'en.wikipedia.org',
  'openrouter.ai',
  'registry.ollama.ai',
  'huggingface.co',
];

export function isHttpAllowlisted(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return HTTP_ALLOWLIST_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function classifyHttpGet(url: string): RiskTier {
  return isHttpAllowlisted(url) ? 'read' : 'sensitive';
}

/** Workspace-scoped fs access: inside the workspace is auto-allowed, outside always asks. */
export function classifyFsPath(resolvedPath: string, workspaceRoot: string, mode: 'read' | 'write'): RiskTier {
  const insideWorkspace = resolvedPath === workspaceRoot || resolvedPath.startsWith(`${workspaceRoot}/`);
  if (insideWorkspace) return mode === 'read' ? 'read' : 'write';
  return 'sensitive';
}
