import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveryReport, InstallOllamaResult, MachineProfile, SetupPlan, SignatureCheck } from '@shared/setup';
import { isOllamaServerUp } from '../models/ollama';

const execFileAsync = promisify(execFile);

/**
 * Conservative "does this already-installed model fit" heuristic — leaves headroom for the
 * OS, the app itself, and inference context, and is independent of our own catalog so any
 * model the user already has (not just ones we'd have recommended) counts toward Path A.
 */
function modelLikelyFits(sizeGb: number, ramGb: number): boolean {
  return sizeGb > 0 && sizeGb <= ramGb * 0.6;
}

/** PLAN.md §6.4 — the four setup paths. */
export function determineSetupPath(profile: MachineProfile, discovery: DiscoveryReport): SetupPlan {
  if (profile.tier === 'minimal') {
    return { path: 'D', reason: `Only ${profile.ramGb}GB RAM detected — the bundled tiny model is the safe fit` };
  }

  const ollama = discovery.runtimes.find((r) => r.id === 'ollama');
  if (ollama?.available) {
    const hasSuitableModel = ollama.models.some((m) => m.chatCapable && modelLikelyFits(m.sizeGb, profile.ramGb));
    if (hasSuitableModel) {
      return { path: 'A', reason: 'Ollama is already running with a model that fits this machine' };
    }
    return { path: 'B', reason: 'Ollama is running but has no installed model that fits yet' };
  }

  return { path: 'C', reason: 'No local LLM runtime was detected' };
}

const DEFAULT_OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download/Ollama-darwin.zip';

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
}

/** Ollama's app build changes every release, so there's no pinned checksum to check like
 * the bundled GGUF — instead this verifies the extracted bundle carries Apple's own
 * notarized Developer ID signature, which is the real trust anchor for a rolling download. */
export async function verifyMacAppSignature(appPath: string): Promise<SignatureCheck> {
  try {
    const { stdout, stderr } = await execFileAsync('spctl', ['--assess', '--type', 'execute', '--verbose', appPath]);
    const output = `${stdout}${stderr}`.trim();
    return { ok: /accepted/.test(output), detail: output };
  } catch (err) {
    const execErr = err as ExecError;
    const output = `${execErr.stdout ?? ''}${execErr.stderr ?? ''}`.trim();
    return { ok: false, detail: output || execErr.message };
  }
}

export interface InstallOllamaOptions {
  downloadUrl?: string;
  /** Injectable for tests — production callers rely on the /Applications default. */
  applicationsDir?: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}

/**
 * Downloads the official Ollama.app zip, extracts it, and verifies its code signature
 * BEFORE moving anything into applicationsDir. Callers must only invoke this after the
 * user has explicitly confirmed the install in the wizard UI (PLAN.md §6.4) — this
 * function itself performs no confirmation of its own.
 */
export async function downloadAndInstallOllama(options: InstallOllamaOptions = {}): Promise<InstallOllamaResult> {
  const url = options.downloadUrl ?? DEFAULT_OLLAMA_DOWNLOAD_URL;
  const applicationsDir = options.applicationsDir ?? '/Applications';

  const workDir = await mkdtemp(join(tmpdir(), 'geepus-ollama-install-'));
  try {
    const zipPath = join(workDir, 'Ollama-darwin.zip');
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Ollama download failed: ${res.status}`);

    const total = Number(res.headers.get('content-length') ?? 0);
    let downloaded = 0;
    const writeStream = createWriteStream(zipPath);
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      options.onProgress?.(downloaded, total);
      if (!writeStream.write(value)) {
        await new Promise<void>((resolve) => writeStream.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    const extractDir = join(workDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    // ditto preserves the app bundle's signature/resource forks correctly, unlike a generic unzip.
    await execFileAsync('ditto', ['-x', '-k', zipPath, extractDir]);

    const extractedAppPath = join(extractDir, 'Ollama.app');
    const signature = await verifyMacAppSignature(extractedAppPath);
    if (!signature.ok) {
      throw new Error(`Downloaded Ollama.app failed signature verification: ${signature.detail}`);
    }

    const finalAppPath = join(applicationsDir, 'Ollama.app');
    await mkdir(applicationsDir, { recursive: true });
    await execFileAsync('ditto', [extractedAppPath, finalAppPath]);

    return { appPath: finalAppPath, signature };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Launches the (GUI) Ollama.app — unlike the CLI's `ollama serve`, opening the app itself
 * starts its background server, so this just opens it and polls the HTTP API.
 */
export async function launchOllamaApp(appPath = '/Applications/Ollama.app', timeoutMs = 20_000): Promise<boolean> {
  await execFileAsync('open', ['-a', appPath]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOllamaServerUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
