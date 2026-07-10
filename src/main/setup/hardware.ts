import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { arch, release, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { MachineProfile } from '@shared/setup';
import { ramTierFor } from '../models/catalog';

const execFileAsync = promisify(execFile);

async function getChipBrand(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string']);
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Apple renamed macOS's sequential numbering to calendar-year-based starting at "macOS 26"
// (Darwin 25), so a flat "major - 9" formula breaks past that point — table the known
// mappings and fall back to the post-rename formula for anything newer.
const DARWIN_TO_MACOS: Record<number, number> = {
  20: 11, // Big Sur
  21: 12, // Monterey
  22: 13, // Ventura
  23: 14, // Sonoma
  24: 15, // Sequoia
  25: 26, // renamed scheme begins
};

export function macOsVersionFromDarwinRelease(darwinRelease: string): string {
  const major = parseInt(darwinRelease.split('.')[0] ?? '0', 10);
  const known = DARWIN_TO_MACOS[major];
  if (known) return `macOS ${known}`;
  if (major > 25) return `macOS ${major + 1}`; // post-rename: Darwin N -> macOS N+1
  return 'macOS (unknown version)';
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Pure hardware facts, no AI involved — deterministic probing (PLAN.md §6.1). */
export async function probeHardware(appDataPath: string): Promise<MachineProfile> {
  const ramGb = bytesToGb(totalmem());
  const chip = await getChipBrand();

  let freeDiskGb = 0;
  try {
    const stats = await statfs(appDataPath);
    freeDiskGb = bytesToGb(stats.bavail * stats.bsize);
  } catch {
    freeDiskGb = 0;
  }

  return {
    chip,
    arch: arch(),
    ramGb,
    freeDiskGb,
    osVersion: macOsVersionFromDarwinRelease(release()),
    tier: ramTierFor(ramGb),
  };
}
