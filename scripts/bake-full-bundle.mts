// Prepares the "full" DMG variant: downloads (or reuses a cached copy of) the pinned tiny
// model and places it under resources/models/ so electron-builder's extraResources config
// bakes it into the packaged app — a fully offline install, no first-run download needed.
// Run before `electron-builder --config electron-builder.full.yml` (see dist:full script).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_MODEL } from '../src/main/models/bundled.ts';

const RESOURCES_MODELS_DIR = join(import.meta.dirname, '..', 'resources', 'models');
const DEV_CACHE_PATH = join(import.meta.dirname, '..', '.dev-cache', BUNDLED_MODEL.filename);
// Also check the app's real userData cache in case it was already downloaded via the lite flow.
// Electron's app name defaults to package.json's "name" ("geepus"), not productName.
const USER_DATA_CACHE_PATH = join(homedir(), 'Library', 'Application Support', 'geepus', 'models', BUNDLED_MODEL.filename);

// The full "chromium" binary, not chromium_headless_shell — PLAN2.md N2's webmail connect
// flow opens a real, visible sign-in window (headless:false), and headless_shell is a
// headless-ONLY stripped build that cannot open a window at all (confirmed live). The full
// binary handles both headless (agent browsing) and headful (webmail) launches, so one
// install covers both — supersedes M7's headless_shell-only optimization, made before
// headful mode was a requirement.
const RESOURCES_BROWSERS_DIR = join(import.meta.dirname, '..', 'resources', 'playwright-browsers');
const browsersJsonPath = join(import.meta.dirname, '..', 'node_modules', 'playwright-core', 'browsers.json');
const browsersJson = JSON.parse(await readFile(browsersJsonPath, 'utf-8')) as { browsers: Array<{ name: string; revision: string }> };
const CHROMIUM_REVISION = browsersJson.browsers.find((b) => b.name === 'chromium')!.revision;
const CHROMIUM_DIRNAME = `chromium-${CHROMIUM_REVISION}`;
const SYSTEM_CACHE_CHROMIUM_PATH = join(homedir(), 'Library', 'Caches', 'ms-playwright', CHROMIUM_DIRNAME);
const USER_DATA_CHROMIUM_PATH = join(homedir(), 'Library', 'Application Support', 'geepus', 'playwright-browsers', CHROMIUM_DIRNAME);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function verifiedCopy(source: string, dest: string): Promise<boolean> {
  if (!(await fileExists(source))) return false;
  const hash = await sha256File(source);
  if (hash !== BUNDLED_MODEL.sha256) {
    console.warn(`Cached model at ${source} has the wrong checksum — ignoring it.`);
    return false;
  }
  await copyFile(source, dest);
  return true;
}

async function downloadFresh(dest: string): Promise<void> {
  console.log(`Downloading ${BUNDLED_MODEL.filename} (~${Math.round(BUNDLED_MODEL.sizeBytes / 1024 / 1024)}MB)...`);
  const res = await fetch(BUNDLED_MODEL.url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);

  const writeStream = createWriteStream(dest);
  const reader = res.body.getReader();
  let downloaded = 0;
  let lastLoggedPct = -1;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    downloaded += value.byteLength;
    const pct = Math.floor((downloaded / BUNDLED_MODEL.sizeBytes) * 100);
    if (pct !== lastLoggedPct && pct % 10 === 0) {
      console.log(`  ${pct}%`);
      lastLoggedPct = pct;
    }
    if (!writeStream.write(value)) await new Promise((resolve) => writeStream.once('drain', resolve));
  }
  await new Promise<void>((resolve, reject) => writeStream.end((err: Error | null) => (err ? reject(err) : resolve())));

  const hash = await sha256File(dest);
  if (hash !== BUNDLED_MODEL.sha256) {
    throw new Error(`Downloaded model checksum mismatch: expected ${BUNDLED_MODEL.sha256}, got ${hash}`);
  }
}

async function bakeModel(): Promise<void> {
  await mkdir(RESOURCES_MODELS_DIR, { recursive: true });
  const dest = join(RESOURCES_MODELS_DIR, BUNDLED_MODEL.filename);

  if ((await fileExists(dest)) && (await sha256File(dest)) === BUNDLED_MODEL.sha256) {
    console.log('Model already present in resources/models/ with a verified checksum.');
    return;
  }
  if (await verifiedCopy(DEV_CACHE_PATH, dest)) {
    console.log(`Reused verified cached model from ${DEV_CACHE_PATH}`);
    return;
  }
  if (await verifiedCopy(USER_DATA_CACHE_PATH, dest)) {
    console.log(`Reused verified cached model from ${USER_DATA_CACHE_PATH}`);
    return;
  }

  await downloadFresh(dest);
  console.log(`Baked ${BUNDLED_MODEL.filename} into resources/models/ for the full DMG variant.`);
}

function installChromium(browsersPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cliPath = join(import.meta.dirname, '..', 'node_modules', 'playwright', 'cli.js');
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium', '--no-shell'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`playwright install exited with code ${code}`))));
  });
}

async function bakeChromium(): Promise<void> {
  const dest = join(RESOURCES_BROWSERS_DIR, CHROMIUM_DIRNAME);

  if (await fileExists(dest)) {
    console.log(`Chromium (${CHROMIUM_DIRNAME}) already present in resources/playwright-browsers/.`);
    return;
  }
  await mkdir(RESOURCES_BROWSERS_DIR, { recursive: true });

  if (await fileExists(SYSTEM_CACHE_CHROMIUM_PATH)) {
    await cp(SYSTEM_CACHE_CHROMIUM_PATH, dest, { recursive: true });
    console.log(`Reused cached ${CHROMIUM_DIRNAME} from ${SYSTEM_CACHE_CHROMIUM_PATH}`);
    return;
  }
  if (await fileExists(USER_DATA_CHROMIUM_PATH)) {
    await cp(USER_DATA_CHROMIUM_PATH, dest, { recursive: true });
    console.log(`Reused cached ${CHROMIUM_DIRNAME} from ${USER_DATA_CHROMIUM_PATH}`);
    return;
  }

  console.log(`Downloading ${CHROMIUM_DIRNAME} into resources/playwright-browsers/...`);
  await installChromium(RESOURCES_BROWSERS_DIR);
  console.log(`Baked ${CHROMIUM_DIRNAME} into resources/playwright-browsers/ for the full DMG variant.`);
}

async function main() {
  await bakeModel();
  await bakeChromium();
}

main().catch((err) => {
  console.error('bake-full-bundle failed:', err.message);
  process.exit(1);
});
