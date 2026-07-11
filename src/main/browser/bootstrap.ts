import { app } from 'electron';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

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
    const cliPath = require.resolve('playwright/cli.js');
    // BrowserSession always launches headless — only-shell skips the ~170MB full Chromium
    // binary we never use (confirmed live: launchPersistentContext({headless:true}) only
    // needs chromium_headless_shell, not the regular chromium build).
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium', '--only-shell'], {
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
