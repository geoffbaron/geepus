import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, verifyAuditChain } from './audit';

describe('AuditLog', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geepus-audit-test-'));
    filePath = join(dir, 'audit.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends entries with an incrementing seq and chained hashes', async () => {
    const log = new AuditLog(filePath);
    await log.init();
    const e1 = await log.append({ tool: 'read_file', argsSummary: 'a.txt', riskTier: 'read', decision: 'auto-allowed' });
    const e2 = await log.append({ tool: 'write_file', argsSummary: 'b.txt', riskTier: 'write', decision: 'auto-allowed' });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);

    const verification = await verifyAuditChain(filePath);
    expect(verification.ok).toBe(true);
    expect(verification.entryCount).toBe(2);
  });

  it('resumes the chain correctly across a fresh AuditLog instance (app restart)', async () => {
    const log1 = new AuditLog(filePath);
    await log1.init();
    const e1 = await log1.append({ tool: 'read_file', argsSummary: 'a.txt', riskTier: 'read', decision: 'auto-allowed' });

    const log2 = new AuditLog(filePath);
    await log2.init();
    const e2 = await log2.append({ tool: 'write_file', argsSummary: 'b.txt', riskTier: 'write', decision: 'auto-allowed' });

    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect((await verifyAuditChain(filePath)).ok).toBe(true);
  });

  it('detects tampering with a past entry', async () => {
    const log = new AuditLog(filePath);
    await log.init();
    await log.append({ tool: 'read_file', argsSummary: 'a.txt', riskTier: 'read', decision: 'auto-allowed' });
    await log.append({ tool: 'write_file', argsSummary: 'b.txt', riskTier: 'write', decision: 'auto-allowed' });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    const tampered = JSON.parse(lines[0]!);
    tampered.decision = 'approved'; // change history without recomputing the hash
    lines[0] = JSON.stringify(tampered);
    await writeFile(filePath, `${lines.join('\n')}\n`);

    const verification = await verifyAuditChain(filePath);
    expect(verification.ok).toBe(false);
    expect(verification.brokenAtSeq).toBe(1);
  });

  it('treats a missing log file as a valid empty chain', async () => {
    expect(await verifyAuditChain(join(dir, 'does-not-exist.log'))).toEqual({ ok: true, entryCount: 0 });
  });
});
