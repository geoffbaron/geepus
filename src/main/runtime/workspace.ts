import { homedir } from 'node:os';
import { join } from 'node:path';

/** M3's minimal default — a real per-project workspace picker is a later milestone. */
export function defaultWorkspaceRoot(): string {
  return join(homedir(), 'Geepus Workspace');
}
