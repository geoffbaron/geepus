import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditDecision = 'auto-allowed' | 'approved' | 'denied' | 'hard-denied';

export interface AuditEntry {
  seq: number;
  timestamp: number;
  tool: string;
  argsSummary: string;
  riskTier: string;
  decision: AuditDecision;
  resultOk?: boolean;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

function computeHash(entryWithoutHash: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(entryWithoutHash)).digest('hex');
}

/** Hash-chained append-only JSONL — every tool execution is logged, and any edit to a
 * past line breaks every hash after it (PLAN.md §9, porting the prototype's audit.js pattern). */
export class AuditLog {
  private seq = 0;
  private lastHash = GENESIS_HASH;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const content = await readFile(this.filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const last = JSON.parse(lastLine) as AuditEntry;
        this.seq = last.seq;
        this.lastHash = last.hash;
      }
    } catch {
      // no existing log — start fresh
    }
  }

  async append(fields: Pick<AuditEntry, 'tool' | 'argsSummary' | 'riskTier' | 'decision' | 'resultOk'>): Promise<AuditEntry> {
    this.seq += 1;
    const withoutHash: Omit<AuditEntry, 'hash'> = {
      seq: this.seq,
      timestamp: Date.now(),
      prevHash: this.lastHash,
      ...fields,
    };
    const hash = computeHash(withoutHash);
    const entry: AuditEntry = { ...withoutHash, hash };
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.lastHash = hash;
    return entry;
  }
}

export interface ChainVerification {
  ok: boolean;
  brokenAtSeq?: number;
  entryCount: number;
}

/** Re-derives every hash from scratch and checks the chain — used to detect tampering. */
export async function verifyAuditChain(filePath: string): Promise<ChainVerification> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { ok: true, entryCount: 0 };
  }

  const lines = content.trim().split('\n').filter(Boolean);
  let expectedPrevHash = GENESIS_HASH;

  for (const line of lines) {
    const entry = JSON.parse(line) as AuditEntry;
    if (entry.prevHash !== expectedPrevHash) {
      return { ok: false, brokenAtSeq: entry.seq, entryCount: lines.length };
    }
    const { hash, ...withoutHash } = entry;
    if (computeHash(withoutHash) !== hash) {
      return { ok: false, brokenAtSeq: entry.seq, entryCount: lines.length };
    }
    expectedPrevHash = hash;
  }

  return { ok: true, entryCount: lines.length };
}
