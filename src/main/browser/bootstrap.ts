import { app } from 'electron';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

let chromiumReady = false;
let chromiumError: string | null = null;

export function isChromiumReady(): boolean {
  return chromiumReady;
}

export function getChromiumBootstrapError(): string | null {
  return chromiumError;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Points Playwright at a per-app browsers directory instead of the shared
 * ~/Library/Caches/ms-playwright, so the "full" DMG variant's baked copy
 * (resources/playwright-browsers, see scripts/bake-full-bundle.mts) is picked
 * up automatically and the "lite" variant gets a stable, predictable
 * first-run download location. Must run before anything imports 'playwright'.
 */
export async function bootstrapChromium(
  onProgress?: (message: string) => void,
): Promise<void> {
  const bakedPath = join(process.resourcesPath, 'playwright-browsers');
  if (await dirExists(bakedPath)) {
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = bakedPath;
    chromiumReady = true;
    return;
  }

  const cachePath = join(app.getPath('userData'), 'playwright-browsers');
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = cachePath;

  // A prior run may have already downloaded it into the cache — launching Chromium
  // itself is the real availability check, but a coarse dir check avoids a pointless
  // ~150-330MB re-download attempt on every startup.
  if (await dirExists(cachePath)) {
    chromiumReady = true;
    return;
  }

  try {
    await runInstall(cachePath, onProgress);
    chromiumReady = true;
  } catch (err) {
    chromiumError = (err as Error).message;
  }
}

function runInstall(browsersPath: string, onProgress?: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // NOT require.resolve('playwright/cli.js') — playwright's package.json `exports` map
    // doesn't list ./cli.js, so that throws ERR_PACKAGE_PATH_NOT_EXPORTED at runtime
    // (found live via the N2 Electron E2E; the lite variant's first-run browser download
    // was silently broken by this — nothing in M7 exercised the download path because the
    // full variant bakes the browser and dev machines had caches). Resolving the package
    // main and deriving cli.js's path sidesteps the exports map, which doesn't apply to
    // plain filesystem joins.
    const cliPath = join(dirname(require.resolve('playwright')), 'cli.js');
    // The full "chromium" binary, not chromium_headless_shell — PLAN2.md N2's webmail
    // connect flow opens a real, visible sign-in window (headless:false), and
    // headless_shell is a headless-ONLY stripped build that cannot open a window at all
    // (confirmed live: launchPersistentContext({headless:false}) throws "Executable
    // doesn't exist" against a headless_shell-only install). The full binary handles both
    // headless (agent browsing) and headful (webmail) launches, so one install covers both
    // — an M7-era optimization that only fetched headless_shell no longer applies now that
    // headful mode is a real requirement. --no-shell skips the redundant shell-only binary.
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium', '--no-shell'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stdout?.on('data', (chunk: Buffer) => onProgress?.(chunk.toString().trim()));
    child.stderr?.on('data', (chunk: Buffer) => onProgress?.(chunk.toString().trim()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium exited with code ${code}`));
    });
  });
}
