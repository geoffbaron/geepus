import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserTarget } from '@shared/browser';
import { getChromiumBootstrapError, isChromiumReady } from './bootstrap';

// Lazy import — playwright ships a real Chromium download, so keep it out of the module
// graph until a browser action is actually used.
type PlaywrightModule = typeof import('playwright');
type BrowserContext = Awaited<ReturnType<PlaywrightModule['chromium']['launchPersistentContext']>>;
export type Page = ReturnType<BrowserContext['pages']>[number];
type Locator = ReturnType<Page['getByRole']>;

/**
 * All interactions are driven by semantic queries — role, label, placeholder, text, name,
 * or css — never fragile numeric element IDs (PLAN.md §7 item 5, ported from the
 * prototype's browser-session.js). This is the bundled-Chromium backend only; the
 * extension-bridge backend (driving the user's real Chrome) is a scoped-out fast-follow —
 * M6's accept criterion only requires bundled Chromium.
 */
export interface BrowserSessionOptions {
  /** false makes a real, visible OS window — used by the webmail connect flow so the user
   * can see and complete their own sign-in. Agent-driven browsing tasks stay headless
   * (true, the default) — nothing about them needs to be on screen. */
  headless?: boolean;
}

export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly profileDir: string;
  private readonly headless: boolean;

  constructor(profileDir: string, options: BrowserSessionOptions = {}) {
    this.profileDir = profileDir;
    this.headless = options.headless ?? true;
  }

  private resolveLocator(page: Page, target: BrowserTarget): Locator {
    if (target.role) {
      return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
        name: target.text,
        exact: target.exact,
      });
    }
    if (target.label) return page.getByLabel(target.label, { exact: target.exact ?? false });
    if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact: target.exact ?? false });
    if (target.text) return page.getByText(target.text, { exact: target.exact ?? false });
    if (target.name) return page.locator(`[name="${target.name}"]`);
    if (target.css) return page.locator(target.css);
    throw new Error('target must have at least one of: role, label, placeholder, text, name, css');
  }

  private async getPageState(page: Page): Promise<string> {
    const url = page.url();
    const title = await page.title().catch(() => '');
    let ariaTree = '';
    try {
      ariaTree = (await page.locator('body').ariaSnapshot({ timeout: 5000 })) || '';
    } catch {
      // A string body (not a typed closure) sidesteps needing DOM lib types in this
      // Node-targeted file — Playwright evaluates it inside the page's own browser context.
      ariaTree = await page
        .evaluate<string>("(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().substring(0, 800)")
        .catch(() => '');
    }
    if (ariaTree.length > 2500) ariaTree = `${ariaTree.slice(0, 2500)}\n... (truncated)`;
    return [`URL: ${url}`, `Title: ${title}`, '', 'Accessibility Tree:', ariaTree || '  (empty — page may be loading)'].join('\n');
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.context) {
      const bootstrapError = getChromiumBootstrapError();
      if (bootstrapError) throw new Error(`browser unavailable: chromium install failed — ${bootstrapError}`);
      if (!isChromiumReady()) throw new Error('browser unavailable: chromium is still downloading, try again shortly');
      const playwright = await import('playwright');
      await mkdir(this.profileDir, { recursive: true });
      // Explicit executablePath, always the full Chromium binary — Playwright's automatic
      // revision lookup hardcodes headless:true to chromium_headless_shell and headless:false
      // to plain chromium (confirmed live: they are NOT interchangeable at the launch-resolution
      // level, even though the full binary natively supports headless launches). Passing the
      // path explicitly bypasses that lookup so one installed/baked binary serves both the
      // agent's headless browsing and the webmail connect flow's real, visible window.
      this.context = await playwright.chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        executablePath: playwright.chromium.executablePath(),
        acceptDownloads: true,
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  async goto(url: string): Promise<string> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.getPageState(page);
  }

  async find(target: BrowserTarget): Promise<string> {
    const page = await this.ensurePage();
    const locator = this.resolveLocator(page, target);
    const count = await locator.count();
    if (count === 0) return 'No matching element found.';
    const first = locator.first();
    const text = await first.innerText().catch(() => '');
    return `Found ${count} matching element(s). First: "${text.trim().slice(0, 200)}"`;
  }

  async click(target: BrowserTarget): Promise<string> {
    const page = await this.ensurePage();
    await this.resolveLocator(page, target).first().click({ timeout: 10_000 });
    return this.getPageState(page);
  }

  async type(target: BrowserTarget, text: string): Promise<string> {
    const page = await this.ensurePage();
    await this.resolveLocator(page, target).first().fill(text, { timeout: 10_000 });
    return this.getPageState(page);
  }

  async selectOption(target: BrowserTarget, value: string): Promise<string> {
    const page = await this.ensurePage();
    await this.resolveLocator(page, target).first().selectOption(value, { timeout: 10_000 });
    return this.getPageState(page);
  }

  async waitFor(condition: { urlContains?: string; text?: string }, timeoutMs = 15_000): Promise<string> {
    const page = await this.ensurePage();
    if (condition.urlContains) {
      await page.waitForURL((url) => url.toString().includes(condition.urlContains!), { timeout: timeoutMs });
    } else if (condition.text) {
      await page.getByText(condition.text).first().waitFor({ timeout: timeoutMs });
    }
    return this.getPageState(page);
  }

  async read(): Promise<string> {
    const page = await this.ensurePage();
    return this.getPageState(page);
  }

  async scroll(direction: 'up' | 'down'): Promise<string> {
    const page = await this.ensurePage();
    await page.mouse.wheel(0, direction === 'down' ? 800 : -800);
    return this.getPageState(page);
  }

  currentUrl(): string | null {
    return this.page && !this.page.isClosed() ? this.page.url() : null;
  }

  /** Brings a headful window in front of other windows — used after navigating so the
   * user actually sees the sign-in page they need to complete (webmail connect flow). */
  async focus(): Promise<void> {
    const page = await this.ensurePage();
    await page.bringToFront();
  }

  /**
   * Escape hatch for callers that need real Playwright Page APIs beyond the generic
   * BrowserTarget-based methods above — e.g. a provider-specific inbox reader that
   * extracts structured data no semantic goto/find/click call can express. Keeps the
   * Playwright Page type encapsulated in this module rather than leaking it everywhere.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.ensurePage();
    return fn(page);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

export function defaultBrowserProfileDir(userDataDir: string): string {
  return join(userDataDir, 'browser-profiles', 'agent');
}
