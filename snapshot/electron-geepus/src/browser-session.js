/**
 * browser-session.js
 *
 * General-purpose browser agent backed by Playwright.
 * All interactions are driven by semantic queries — never fragile numeric IDs.
 *
 * Primitives exposed via performBrowserAction():
 *   goto(url)
 *   find(target)            — role, text, label, placeholder, name, css
 *   click(target)
 *   type(target, text)
 *   press(key)
 *   select(target, value)
 *   wait_for(condition)     — url_contains, text, element
 *   read(query)             — url, text, attr
 *   scroll(direction)
 *
 * Every action returns: { ok, summary, output }
 *   output = URL + Title + VerificationContext (visible text excerpt + matched element info)
 *
 * This is intentionally site-agnostic. No hardcoded flows.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { extensionBridge } = require('./extension-bridge');

let playwright = null;
try {
    playwright = require('playwright');
} catch {
    // Playwright not installed in all environments
}

let activeContext = null;
let activePage = null;
let latestDownload = null;
let recentConsoleEvents = [];

function downloadsDir() {
    return path.join(app.getPath('userData'), 'browser-downloads');
}

function describeLatestDownload(download) {
    if (!download || !download.path) return '';
    const name = String(download.suggestedFilename || path.basename(download.path) || '').trim();
    return [
        `Last download saved to: ${download.path}`,
        name ? `Last download filename: ${name}` : '',
    ].filter(Boolean).join('\n');
}

function withLatestDownloadOutput(output = '') {
    const base = String(output || '');
    const extra = describeLatestDownload(latestDownload);
    if (!extra) return base;
    return `${base}\n${extra}`.trim();
}

function buildDownloadMetadata(download) {
    if (!download || !download.path) {
        return {
            downloadPath: '',
            downloadFilename: '',
        };
    }
    return {
        downloadPath: String(download.path || ''),
        downloadFilename: String(download.suggestedFilename || path.basename(download.path) || ''),
    };
}

function resetBrowserDiagnostics() {
    recentConsoleEvents = [];
}

function trimConsoleEvents() {
    if (recentConsoleEvents.length > 200) {
        recentConsoleEvents = recentConsoleEvents.slice(-200);
    }
}

async function formatConsoleEvent(msg) {
    try {
        const type = typeof msg.type === 'function' ? String(msg.type() || 'log') : 'log';
        const text = typeof msg.text === 'function' ? String(msg.text() || '').trim() : '';
        const location = typeof msg.location === 'function' ? msg.location() : {};
        const url = String(location?.url || '').trim();
        const lineNumber = Number.isFinite(Number(location?.lineNumber)) ? Number(location.lineNumber) : null;
        return {
            type,
            text,
            url,
            lineNumber,
            recordedAt: new Date().toISOString(),
        };
    } catch {
        return {
            type: 'log',
            text: '',
            url: '',
            lineNumber: null,
            recordedAt: new Date().toISOString(),
        };
    }
}

function registerConsoleTracking(page) {
    if (!page || typeof page.on !== 'function') return;
    page.on('console', async (msg) => {
        const event = await formatConsoleEvent(msg);
        recentConsoleEvents.push(event);
        trimConsoleEvents();
    });
    page.on('pageerror', (error) => {
        recentConsoleEvents.push({
            type: 'pageerror',
            text: String(error?.message || error || '').trim(),
            url: page.url ? String(page.url() || '') : '',
            lineNumber: null,
            recordedAt: new Date().toISOString(),
        });
        trimConsoleEvents();
    });
}

function getContextPages() {
    if (!activeContext || typeof activeContext.pages !== 'function') return [];
    return activeContext.pages().filter((page) => page && typeof page.isClosed === 'function' && !page.isClosed());
}

async function setActivePageAndTrack(page) {
    activePage = page || null;
    registerDownloadTracking(activePage);
    registerConsoleTracking(activePage);
    return activePage;
}

function summarizeTabs() {
    const pages = getContextPages();
    if (pages.length === 0) return 'Open tabs:\n  (none)';
    const lines = pages.map((page, index) => {
        const marker = page === activePage ? '*' : ' ';
        const url = typeof page.url === 'function' ? String(page.url() || '') : '';
        return `${marker} Tab ${index}: ${url || '(about:blank)'}`;
    });
    return `Open tabs:\n${lines.join('\n')}`;
}

function formatConsoleEvents({ errorsOnly = false } = {}) {
    const list = recentConsoleEvents.filter((entry) => !errorsOnly || entry.type === 'error' || entry.type === 'pageerror');
    if (list.length === 0) {
        return errorsOnly ? 'Browser console errors:\n  (none)' : 'Browser console messages:\n  (none)';
    }
    const title = errorsOnly ? 'Browser console errors:' : 'Browser console messages:';
    const lines = list.slice(-40).map((entry, index) => {
        const suffix = entry.url ? ` @ ${entry.url}${entry.lineNumber != null ? `:${entry.lineNumber}` : ''}` : '';
        return `  ${index + 1}. [${entry.type}] ${entry.text || '(empty)'}${suffix}`;
    });
    return `${title}\n${lines.join('\n')}`;
}

function registerDownloadTracking(page) {
    if (!page || typeof page.on !== 'function') return;
    page.on('download', async (download) => {
        try {
            const dir = downloadsDir();
            await fs.mkdir(dir, { recursive: true });
            const suggestedFilename = typeof download.suggestedFilename === 'function'
                ? String(download.suggestedFilename() || '').trim()
                : '';
            const filename = suggestedFilename || `download-${Date.now()}`;
            const targetPath = path.join(dir, filename);
            if (typeof download.saveAs === 'function') {
                await download.saveAs(targetPath);
            }
            latestDownload = {
                path: targetPath,
                suggestedFilename: filename,
                createdAt: new Date().toISOString(),
            };
        } catch {
            // Ignore download persistence failures so page interaction does not crash.
        }
    });
}

function shouldUseAttachedExtensionMode(args = {}) {
    const sessionMode = String(args.session_mode || '').trim().toLowerCase();
    return sessionMode === 'attached'
        || sessionMode === 'extension'
        || args.attach_to_active_tab === true
        || args.prefer_extension === true;
}

function canUseExtensionBridge() {
    return Boolean(extensionBridge && extensionBridge.isConnected());
}

function formatExtensionFrames(frames) {
    const list = Array.isArray(frames) ? frames : [];
    if (list.length === 0) {
        return 'Frames on this page:\n  (none)';
    }
    const lines = list.map((frame) => {
        const index = Number.isFinite(Number(frame.index)) ? Number(frame.index) : '?';
        const frameId = Number.isFinite(Number(frame.frameId)) ? Number(frame.frameId) : '?';
        const parentFrameId = Number.isFinite(Number(frame.parentFrameId)) ? Number(frame.parentFrameId) : -1;
        const url = String(frame.url || '');
        const suffix = frame.errorOccurred ? ' [error]' : '';
        return `  Frame ${index} (id=${frameId}, parent=${parentFrameId}): ${url}${suffix}`;
    });
    return `Frames on this page:\n${lines.join('\n')}`;
}

function formatExtensionState(stateResponse) {
    if (typeof stateResponse === 'string') {
        return stateResponse;
    }
    if (Array.isArray(stateResponse)) {
        return formatExtensionFrames(stateResponse);
    }
    if (stateResponse && typeof stateResponse === 'object') {
        if (Array.isArray(stateResponse.frames)) {
            return formatExtensionFrames(stateResponse.frames);
        }
        if (typeof stateResponse.output === 'string') {
            return stateResponse.output;
        }
        return JSON.stringify(stateResponse, null, 2);
    }
    return String(stateResponse || '');
}

function formatExtensionActionOutput(action, resultMsg) {
    if (action === 'frames') {
        return formatExtensionFrames(resultMsg);
    }
    return formatExtensionState(resultMsg);
}

function parseBrowserOutput(output) {
    const text = String(output || '');
    const metadata = {
        pageUrl: '',
        pageTitle: '',
        screenshotPath: '',
        downloadPath: '',
        downloadFilename: '',
        frames: [],
    };

    const urlMatch = text.match(/^URL:\s*(.+)$/m);
    if (urlMatch) {
        metadata.pageUrl = String(urlMatch[1] || '').trim();
    }

    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    if (titleMatch) {
        metadata.pageTitle = String(titleMatch[1] || '').trim();
    }

    const screenshotMatch = text.match(/Screenshot saved to:\s*(.+)$/m);
    if (screenshotMatch) {
        metadata.screenshotPath = String(screenshotMatch[1] || '').trim();
    }

    const downloadPathMatch = text.match(/Last download saved to:\s*(.+)$/m);
    if (downloadPathMatch) {
        metadata.downloadPath = String(downloadPathMatch[1] || '').trim();
    }

    const downloadFilenameMatch = text.match(/Last download filename:\s*(.+)$/m);
    if (downloadFilenameMatch) {
        metadata.downloadFilename = String(downloadFilenameMatch[1] || '').trim();
    }

    const frameMatches = Array.from(text.matchAll(/^\s*Frame\s+(\d+)(?:\s+\(id=(\d+),\s*parent=(-?\d+)\))?:\s*(.+?)(\s+\[error\])?$/gm));
    metadata.frames = frameMatches.map((match) => ({
        index: Number(match[1]),
        frameId: match[2] ? Number(match[2]) : null,
        parentFrameId: match[3] ? Number(match[3]) : null,
        url: String(match[4] || '').trim(),
        errorOccurred: Boolean(match[5]),
    }));

    return metadata;
}

function normalizeFrameMetadata(frames, fallbackFrames = []) {
    const source = Array.isArray(frames) && frames.length > 0 ? frames : fallbackFrames;
    return source.map((frame, index) => ({
        index: Number.isFinite(Number(frame.index)) ? Number(frame.index) : index,
        frameId: Number.isFinite(Number(frame.frameId)) ? Number(frame.frameId) : null,
        parentFrameId: Number.isFinite(Number(frame.parentFrameId)) ? Number(frame.parentFrameId) : null,
        url: String(frame.url || ''),
        errorOccurred: frame.errorOccurred === true,
    }));
}

function collectPlaywrightFrameMetadata(page) {
    if (!page || typeof page.frames !== 'function') return [];
    return page.frames().map((frame, index) => ({
        index,
        frameId: null,
        parentFrameId: null,
        url: typeof frame.url === 'function' ? String(frame.url() || '') : '',
        errorOccurred: false,
    }));
}

function buildBrowserMetadata(output, extra = {}) {
    const parsed = parseBrowserOutput(output);
    const merged = {
        ...parsed,
        ...extra,
    };
    merged.frames = normalizeFrameMetadata(extra.frames, parsed.frames);
    merged.downloadPath = String(extra.downloadPath || parsed.downloadPath || '');
    merged.downloadFilename = String(extra.downloadFilename || parsed.downloadFilename || '');
    return merged;
}

function getActionContext(args = {}) {
    if (!activePage || activePage.isClosed()) {
        throw new Error('No active browser session. Call browser_launch first, or connect the Chrome extension.');
    }
    const frameIndex = Number.isInteger(args.frame_index) ? args.frame_index : null;
    if (frameIndex === null || frameIndex < 0) {
        return activePage;
    }
    const frames = activePage.frames();
    const frame = frames[frameIndex];
    if (!frame) {
        throw new Error(`Invalid frame_index ${frameIndex}. Use the frames action first to inspect available frames.`);
    }
    return frame;
}

function hasActiveOwnedSession() {
    return Boolean(activePage && typeof activePage.isClosed === 'function' && !activePage.isClosed());
}

// ---------------------------------------------------------------------------
// Semantic Locator Resolution
// ---------------------------------------------------------------------------
// Translates a target query object into a Playwright locator using the highest-
// fidelity strategy available. Falls back through multiple strategies.
//
// Supported query keys (in priority order):
//   role      — { role: "button", text: "Submit" }
//   label     — { label: "Email address" }
//   placeholder — { placeholder: "Search..." }
//   text      — { text: "Sign in" }
//   name      — { name: "username" }   (matches name= attribute)
//   css       — { css: "#email-input" }
// ---------------------------------------------------------------------------

function resolveLocator(page, target) {
    if (!target || typeof target !== 'object') {
        throw new Error(`target must be an object with a query key (role, label, placeholder, text, name, or css). Got: ${JSON.stringify(target)}`);
    }

    if (target.role) {
        const opts = {};
        if (target.text) opts.name = target.text;
        if (target.exact !== undefined) opts.exact = target.exact;
        return page.getByRole(target.role, opts);
    }

    if (target.label) {
        return page.getByLabel(target.label, { exact: target.exact ?? false });
    }

    if (target.placeholder) {
        return page.getByPlaceholder(target.placeholder, { exact: target.exact ?? false });
    }

    if (target.text) {
        return page.getByText(target.text, { exact: target.exact ?? false });
    }

    if (target.name) {
        return page.locator(`[name="${target.name}"]`);
    }

    if (target.css) {
        return page.locator(target.css);
    }

    throw new Error(
        `target must have at least one of: role, label, placeholder, text, name, css. Got: ${JSON.stringify(target)}`
    );
}

// ---------------------------------------------------------------------------
// Page State Summary
// Uses locator.ariaSnapshot() — the Playwright 1.48+ ARIA tree API.
// Also inspects all child frames so iframe-embedded forms are visible.
// ---------------------------------------------------------------------------

/**
 * Returns a readable ARIA snapshot of a given Playwright Page or Frame.
 */
async function getFrameAriaSnapshot(frame) {
    try {
        // locator.ariaSnapshot() is available since Playwright 1.48
        const snapshot = await frame.locator('body').ariaSnapshot({ timeout: 5000 });
        return snapshot || '';
    } catch {
        // Fallback: read visible text
        try {
            return await frame.evaluate(() =>
                (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 800)
            );
        } catch { return ''; }
    }
}

async function getPageState(page) {
    const url = page.url();
    const title = await page.title().catch(() => '');

    // Get ARIA snapshot of the main frame
    let ariaTree = await getFrameAriaSnapshot(page);

    // Also collect any child frames that have meaningful content
    const frameSnippets = [];
    try {
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const frameUrl = frame.url();
            if (!frameUrl || frameUrl === 'about:blank') continue;
            const content = await getFrameAriaSnapshot(frame);
            if (content && content.length > 20) {
                frameSnippets.push(`  [frame: ${frameUrl.substring(0, 80)}]\n  ${content.substring(0, 600)}`);
            }
        }
    } catch { /* ignore frame access errors */ }

    if (ariaTree.length > 2500) ariaTree = ariaTree.substring(0, 2500) + '\n... (truncated)';

    const parts = [
        `URL: ${url}`,
        `Title: ${title}`,
        `\nAccessibility Tree:`,
        ariaTree || '  (empty — page may be loading)',
    ];
    if (frameSnippets.length > 0) {
        parts.push(`\nChild Frames (${frameSnippets.length}):`);
        parts.push(...frameSnippets);
    }
    return parts.join('\n');
}

// ---------------------------------------------------------------------------
// browser_launch  (goto URL, start session)
// ---------------------------------------------------------------------------

async function launchBrowserAction(args) {
    const url = String(args.url || '').trim();
    if (!url) throw new Error('url is required');

    const useExtensionBridge = canUseExtensionBridge()
        && (shouldUseAttachedExtensionMode(args) || !playwright);

    if (useExtensionBridge) {
        try {
            await extensionBridge.sendAction('goto', { url });
            // Let the extension fetch the updated state
            const stateResponse = await extensionBridge.sendAction('aria_snapshot', {});
            const formattedState = formatExtensionState(stateResponse);
            return {
                ok: true,
                summary: `Navigated to ${url} (via extension proxy)`,
                output: formattedState,
                metadata: buildBrowserMetadata(formattedState),
            };
        } catch (err) {
            throw new Error(`Extension Bridge goto failed: ${err.message}`);
        }
    }

    if (!playwright) throw new Error('Playwright is not installed and Extension Bridge is not connected.');

    const headless = args.headless !== false;

    if (activeContext) {
        await activeContext.close().catch(() => { });
        activeContext = null;
        activePage = null;
    }
    latestDownload = null;
    resetBrowserDiagnostics();

    const profileDir = path.join(app.getPath('userData'), 'browser-profiles', 'interactive');
    await fs.mkdir(profileDir, { recursive: true });

    activeContext = await playwright.chromium.launchPersistentContext(profileDir, {
        headless,
        acceptDownloads: true,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    await setActivePageAndTrack(activeContext.pages()[0] || await activeContext.newPage());
    await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const state = withLatestDownloadOutput(await getPageState(activePage));
    return {
        ok: true,
        summary: `Navigated to ${url}`,
        output: state,
        metadata: buildBrowserMetadata(state, {
            frames: collectPlaywrightFrameMetadata(activePage),
            ...buildDownloadMetadata(latestDownload),
        }),
    };
}

// ---------------------------------------------------------------------------
// performBrowserAction  (all semantic primitives)
// ---------------------------------------------------------------------------

async function performBrowserAction(args) {
    const hasOwnedSession = Boolean(activePage && !activePage.isClosed());
    const useExtensionBridge = canUseExtensionBridge()
        && !hasOwnedSession
        && (shouldUseAttachedExtensionMode(args) || !playwright);

    if (useExtensionBridge) {
        const action = String(args.action || '').trim().toLowerCase();

        try {
            // Forward the exact raw args so the extension handles target semantic resolution natively
            const resultMsg = await extensionBridge.sendAction(action, { exact_args: args });

            if (action === 'screenshot' && resultMsg && typeof resultMsg === 'object' && resultMsg.screenshotDataUrl) {
                const screenshotDir = path.join(app.getPath('userData'), 'browser-screenshots');
                await fs.mkdir(screenshotDir, { recursive: true });
                const ts = Date.now();
                const screenshotPath = path.join(screenshotDir, `extension-screenshot-${ts}.png`);
                const base64 = String(resultMsg.screenshotDataUrl).replace(/^data:image\/png;base64,/, '');
                await fs.writeFile(screenshotPath, Buffer.from(base64, 'base64'));
                const stateResponse = await extensionBridge.sendAction('aria_snapshot', {});
                const formattedState = formatExtensionState(stateResponse);
                const screenshotOutput = `Screenshot saved to: ${screenshotPath}\nPass this path to analyze_image to inspect the page visually.\n\nCurrent Page State:\n${formattedState}`;
                return {
                    ok: true,
                    summary: 'Extension Action: screenshot',
                    output: screenshotOutput,
                    metadata: buildBrowserMetadata(screenshotOutput),
                };
            }

            if (action === 'wait_for' && args.condition && args.condition.ms) {
                // Agent depends on this API to sleep
                await new Promise(r => setTimeout(r, Math.min(Number(args.condition.ms), 10000)));
            }

            // Re-fetch page state after modifying the DOM
            let nextState = '';
            if (['click', 'type', 'fill', 'press', 'select', 'wait_for', 'hover', 'scroll', 'mouse_click', 'mouse_move', 'type_at', 'back', 'forward', 'reload'].includes(action)) {
                const stateResponse = await extensionBridge.sendAction('aria_snapshot', {});
                nextState = '\n\nCurrent page state:\n' + formatExtensionState(stateResponse);
            }

            let resultStr = formatExtensionActionOutput(action, resultMsg);

            if (typeof resultMsg === 'object' && resultMsg !== null && resultMsg.error) {
                throw new Error(resultMsg.error);
            }

            return {
                ok: true,
                summary: `Extension Action: ${action}`,
                output: `${resultStr}${nextState}`,
                metadata: buildBrowserMetadata(`${resultStr}${nextState}`, {
                    frames: action === 'frames' && Array.isArray(resultMsg) ? resultMsg : [],
                }),
            };
        } catch (error) {
            let recoveryState = '';
            try {
                const stateResponse = await extensionBridge.sendAction('aria_snapshot', {});
                recoveryState = '\n\nCurrent page state:\n' + formatExtensionState(stateResponse);
            } catch { /* ignore */ }
            return {
                ok: false,
                summary: `Extension Action '${action}' failed`,
                output: error.message + recoveryState,
            }
        }
    }

    const action = String(args.action || '').trim().toLowerCase();
    const target = args.target || null;   // semantic query object
    const text = String(args.text || '');
    const key = String(args.key || args.text || 'Enter');
    const value = String(args.value || args.text || '');

    try {
        let summary = '';

        switch (action) {

            // ── goto(url) ─────────────────────────────────────────────────
            case 'goto': {
                const url = String(args.url || args.text || '').trim();
                if (!url) throw new Error('goto requires a url arg');
                await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                summary = `Navigated to ${url}`;
                break;
            }

            // ── find(target) ──────────────────────────────────────────────
            case 'find': {
                const actionContext = getActionContext(args);
                const locator = resolveLocator(actionContext, target);
                const count = await locator.count();
                if (count === 0) {
                    throw new Error(`find: No elements matching ${JSON.stringify(target)}`);
                }
                const texts = [];
                for (let i = 0; i < Math.min(count, 5); i++) {
                    const t = await locator.nth(i).innerText().catch(() => '');
                    const v = await locator.nth(i).getAttribute('value').catch(() => '');
                    texts.push(t || v || '(no text)');
                }
                summary = `Found ${count} element(s) matching ${JSON.stringify(target)}: ${texts.join(' | ')}`;
                // No state change — return immediately with just the match summary
                return { ok: true, summary, output: summary };
            }

            // ── click(target) ─────────────────────────────────────────────
            case 'click': {
                const actionContext = getActionContext(args);
                const locator = resolveLocator(actionContext, target);
                await locator.first().scrollIntoViewIfNeeded().catch(() => { });
                await locator.first().click();
                await activePage.waitForLoadState('load', { timeout: 5000 }).catch(() => { });
                summary = `Clicked: ${JSON.stringify(target)}`;
                break;
            }

            // ── type(target, text) ────────────────────────────────────────
            case 'type':
            case 'fill': {
                const actionContext = getActionContext(args);
                const locator = resolveLocator(actionContext, target);
                await locator.first().scrollIntoViewIfNeeded().catch(() => { });
                await locator.first().fill(text);
                summary = `Typed "${text}" into: ${JSON.stringify(target)}`;
                break;
            }

            // ── press(key) ────────────────────────────────────────────────
            case 'press': {
                await activePage.keyboard.press(key);
                await activePage.waitForLoadState('load', { timeout: 3000 }).catch(() => { });
                summary = `Pressed key: ${key}`;
                break;
            }

            // ── select(target, value) ─────────────────────────────────────
            case 'select': {
                const actionContext = getActionContext(args);
                const locator = resolveLocator(actionContext, target);
                await locator.first().scrollIntoViewIfNeeded().catch(() => { });
                await locator.first().selectOption(value);
                summary = `Selected "${value}" in: ${JSON.stringify(target)}`;
                break;
            }

            // ── wait_for(condition) ───────────────────────────────────────
            case 'wait_for': {
                const condition = args.condition || args;
                if (condition.url_contains) {
                    if (!hasActiveOwnedSession()) throw new Error('No active browser session for wait_for.url_contains');
                    await activePage.waitForURL(`**${condition.url_contains}**`, { timeout: 15000 });
                    summary = `Page URL now contains: ${condition.url_contains}`;
                } else if (condition.network_idle || condition.networkidle) {
                    if (!hasActiveOwnedSession()) throw new Error('No active browser session for wait_for.network_idle');
                    await activePage.waitForLoadState('networkidle', { timeout: 15000 });
                    summary = 'Network became idle';
                } else if (condition.load) {
                    if (!hasActiveOwnedSession()) throw new Error('No active browser session for wait_for.load');
                    const state = String(condition.load || 'load');
                    await activePage.waitForLoadState(state, { timeout: 15000 });
                    summary = `Page load state reached: ${state}`;
                } else if (condition.text) {
                    const actionContext = getActionContext(args);
                    await actionContext.waitForFunction(
                        (t) => document.body && document.body.innerText.includes(t),
                        condition.text,
                        { timeout: 10000 }
                    );
                    summary = `Text appeared on page: "${condition.text}"`;
                } else if (condition.element) {
                    const actionContext = getActionContext(args);
                    const locator = resolveLocator(actionContext, condition.element);
                    await locator.first().waitFor({ state: 'visible', timeout: 10000 });
                    summary = `Element became visible: ${JSON.stringify(condition.element)}`;
                } else if (condition.ms) {
                    await new Promise((resolve) => setTimeout(resolve, Math.min(Number(condition.ms), 10000)));
                    summary = `Waited ${condition.ms}ms`;
                } else {
                    throw new Error('wait_for requires a condition: url_contains, load, text, element, or ms');
                }
                break;
            }

            // ── read(query) ───────────────────────────────────────────────
            case 'read': {
                const query = args.query || args;
                if (query.url || query === 'url') {
                    const output = `URL: ${activePage.url()}`;
                    return {
                        ok: true,
                        summary: `URL: ${activePage.url()}`,
                        output,
                        metadata: buildBrowserMetadata(output, {
                            frames: collectPlaywrightFrameMetadata(activePage),
                            ...buildDownloadMetadata(latestDownload),
                        }),
                    };
                }
                if (query.title || query === 'title') {
                    const title = await activePage.title().catch(() => '');
                    const output = `Title: ${title}`;
                    return {
                        ok: true,
                        summary: `Title: ${title}`,
                        output,
                        metadata: buildBrowserMetadata(output, {
                            frames: collectPlaywrightFrameMetadata(activePage),
                            ...buildDownloadMetadata(latestDownload),
                        }),
                    };
                }
                if (query.attr && target) {
                    const actionContext = getActionContext(args);
                    const locator = resolveLocator(actionContext, target);
                    const attrVal = await locator.first().getAttribute(query.attr).catch(() => '');
                    const inputVal = await locator.first().inputValue().catch(() => '');
                    const result = attrVal || inputVal || '(empty)';
                    return {
                        ok: true,
                        summary: `${query.attr} = "${result}"`,
                        output: result,
                        metadata: buildBrowserMetadata(await getPageState(activePage), {
                            frames: collectPlaywrightFrameMetadata(activePage),
                            ...buildDownloadMetadata(latestDownload),
                        }),
                    };
                }
                // Default: return visible body text
                const actionContext = getActionContext(args);
                const bodyText = await actionContext.evaluate(() =>
                    (document.body.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 800)
                );
                return {
                    ok: true,
                    summary: 'Page text',
                    output: bodyText,
                    metadata: buildBrowserMetadata(await getPageState(activePage), {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            // ── scroll(direction) ─────────────────────────────────────────
            case 'scroll': {
                const direction = String(args.direction || args.text || 'down').toLowerCase();
                await activePage.mouse.wheel(0, direction === 'up' ? -400 : 400);
                await activePage.waitForTimeout(400);
                summary = `Scrolled ${direction}`;
                break;
            }

            // ── hover(target) ─────────────────────────────────────────────
            case 'hover': {
                const actionContext = getActionContext(args);
                const locator = resolveLocator(actionContext, target);
                await locator.first().scrollIntoViewIfNeeded();
                await locator.first().hover();
                summary = `Hovered over: ${JSON.stringify(target)}`;
                break;
            }

            // ── back / forward / reload ──────────────────────────────────
            case 'back': {
                await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                summary = 'Navigated back';
                break;
            }

            case 'forward': {
                await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                summary = 'Navigated forward';
                break;
            }

            case 'reload': {
                await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                summary = 'Reloaded page';
                break;
            }

            case 'new_tab': {
                if (!activeContext || typeof activeContext.newPage !== 'function') {
                    throw new Error('No active browser context. Launch a browser session first.');
                }
                const nextPage = await activeContext.newPage();
                await setActivePageAndTrack(nextPage);
                const nextUrl = String(args.url || '').trim();
                if (nextUrl) {
                    await activePage.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    summary = `Opened a new tab and navigated to ${nextUrl}`;
                } else {
                    summary = 'Opened a new blank tab';
                }
                break;
            }

            case 'list_tabs': {
                const output = summarizeTabs();
                return {
                    ok: true,
                    summary: `${getContextPages().length} open tab(s)`,
                    output,
                    metadata: buildBrowserMetadata(output, {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            case 'switch_tab': {
                const tabIndex = Number(args.tab_index ?? args.index);
                const pages = getContextPages();
                if (!Number.isInteger(tabIndex) || tabIndex < 0 || tabIndex >= pages.length) {
                    throw new Error(`switch_tab requires a valid tab_index. Current tabs: ${pages.length}`);
                }
                await setActivePageAndTrack(pages[tabIndex]);
                summary = `Switched to tab ${tabIndex}`;
                break;
            }

            case 'close_tab': {
                const pages = getContextPages();
                const tabIndex = Number.isInteger(Number(args.tab_index ?? args.index))
                    ? Number(args.tab_index ?? args.index)
                    : pages.indexOf(activePage);
                if (tabIndex < 0 || tabIndex >= pages.length) {
                    throw new Error(`close_tab requires a valid tab_index. Current tabs: ${pages.length}`);
                }
                const pageToClose = pages[tabIndex];
                await pageToClose.close().catch(() => { });
                const remaining = getContextPages();
                await setActivePageAndTrack(remaining[Math.max(0, Math.min(tabIndex, remaining.length - 1))] || null);
                summary = `Closed tab ${tabIndex}`;
                break;
            }

            case 'console_messages': {
                const output = formatConsoleEvents({ errorsOnly: false });
                return {
                    ok: true,
                    summary: 'Browser console messages',
                    output,
                    metadata: buildBrowserMetadata(output, {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            case 'console_errors': {
                const output = formatConsoleEvents({ errorsOnly: true });
                return {
                    ok: true,
                    summary: 'Browser console errors',
                    output,
                    metadata: buildBrowserMetadata(output, {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            // ── screenshot() ──────────────────────────────────────────────
            // Captures the current browser viewport as a PNG file.
            // Returns the absolute path — pass it directly to analyze_image.
            // Use this when DOM/ARIA interaction fails: screenshot → analyze_image
            // to identify coordinates → mouse_click at (x, y).
            case 'screenshot': {
                const screenshotDir = path.join(app.getPath('userData'), 'browser-screenshots');
                await fs.mkdir(screenshotDir, { recursive: true });
                const ts = Date.now();
                const screenshotPath = path.join(screenshotDir, `screenshot-${ts}.png`);
                await activePage.screenshot({ path: screenshotPath, fullPage: false });

                // Get page state so the agent doesn't go blind
                const ariaState = await activePage.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '(no ARIA state available)');

                return {
                    ok: true,
                    summary: `Screenshot saved`,
                    output: withLatestDownloadOutput(`Screenshot saved to: ${screenshotPath}\nPass this path to analyze_image to inspect the page visually.\n\nCurrent Page State (ARIA):\n${ariaState.substring(0, 4000)}`),
                    metadata: buildBrowserMetadata(withLatestDownloadOutput(`Screenshot saved to: ${screenshotPath}`), buildDownloadMetadata(latestDownload)),
                };
            }

            // ── mouse_click(x, y) ─────────────────────────────────────────
            // Clicks at an exact pixel coordinate in the browser viewport.
            // Use after analyze_image returns the coordinates of the target.
            // This bypasses ALL DOM, ARIA, and iframe limitations.
            // e.g. {"action":"mouse_click","x":320,"y":450}
            case 'mouse_click': {
                const mx = Number(args.x ?? 0);
                const my = Number(args.y ?? 0);
                await activePage.mouse.click(mx, my);
                await activePage.waitForLoadState('load', { timeout: 3000 }).catch(() => { });
                summary = `Clicked at (${mx}, ${my})`;
                break;
            }

            // ── mouse_move(x, y) ──────────────────────────────────────────
            // Moves the mouse to an exact pixel coordinate without clicking.
            // Useful for hovering over elements to trigger dropdowns.
            case 'mouse_move': {
                const mmx = Number(args.x ?? 0);
                const mmy = Number(args.y ?? 0);
                await activePage.mouse.move(mmx, mmy);
                summary = `Moved mouse to (${mmx}, ${mmy})`;
                break;
            }

            // ── type_at(x, y, text) ───────────────────────────────────────
            // Clicks at coordinates then types text — for inputs identified visually.
            case 'type_at': {
                const tx = Number(args.x ?? 0);
                const ty = Number(args.y ?? 0);
                const typeText = String(args.text || '');
                await activePage.mouse.click(tx, ty);
                await activePage.waitForTimeout(150);
                await activePage.keyboard.type(typeText, { delay: 30 });
                summary = `Clicked (${tx}, ${ty}) and typed: "${typeText}"`;
                break;
            }

            // ── aria_snapshot(target?) ─────────────────────────────────────
            // Returns the full ARIA accessibility tree for a given element,
            // or the entire page if no target is specified.
            // Use this to inspect custom comboboxes, listboxes, date pickers —
            // ANY component whose children are not visible in the page summary.
            case 'aria_snapshot': {
                // Uses locator.ariaSnapshot() — Playwright 1.48+ API (replaces removed page.accessibility)
                // If target specified, snapshots that element. Otherwise snapshots the whole page body.
                // Also checks child frames if page body is empty.
                let snapshotText = '';
                const targetPage = getActionContext(args);

                if (target) {
                    const locator = resolveLocator(targetPage, target);
                    snapshotText = await locator.first().ariaSnapshot({ timeout: 5000 }).catch(() => '');
                } else {
                    snapshotText = await targetPage.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
                }

                // If main frame is empty, look in child frames
                if (!snapshotText || snapshotText.length < 20) {
                    for (const frame of activePage.frames()) {
                        if (frame === activePage.mainFrame()) continue;
                        const frameContent = await frame.locator('body').ariaSnapshot({ timeout: 3000 }).catch(() => '');
                        if (frameContent && frameContent.length > 20) {
                            snapshotText += `\n[Frame: ${frame.url().substring(0, 80)}]\n${frameContent}`;
                        }
                    }
                }

                if (snapshotText.length > 4000) snapshotText = snapshotText.substring(0, 4000) + '\n... (truncated)';
                const state = withLatestDownloadOutput(await getPageState(activePage));
                return {
                    ok: true,
                    summary: `ARIA snapshot${target ? ' for ' + JSON.stringify(target) : ' (full page)'}`,
                    output: snapshotText || '(no ARIA content found — page may still be loading)',
                    metadata: buildBrowserMetadata(state, {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            // ── frames — list all frames on the page ──────────────────────
            // Use this to discover iframes and their content.
            // Then use frame_index in subsequent actions to target a specific frame.
            case 'frames': {
                const frames = activePage.frames();
                const info = frames.map((f, i) => `  Frame ${i}: ${f.url().substring(0, 100)}`).join('\n');
                const state = withLatestDownloadOutput(await getPageState(activePage));
                return {
                    ok: true,
                    summary: `${frames.length} frame(s) found`,
                    output: `Frames on this page:\n${info || '  (none)'}`,
                    metadata: buildBrowserMetadata(state, {
                        frames: collectPlaywrightFrameMetadata(activePage),
                        ...buildDownloadMetadata(latestDownload),
                    }),
                };
            }

            // ── evaluate(script) ──────────────────────────────────────────
            // Executes arbitrary JavaScript in the page context.
            // Specify frame_index to run in a child frame (use the 'frames' action first).
            // e.g. {"action":"evaluate","script":"document.querySelector('[aria-label=\"Month\"]').click()"}
            case 'evaluate': {
                const script = String(args.script || args.text || '');
                if (!script) throw new Error('evaluate requires a "script" argument');
                const evalTarget = getActionContext(args);
                const result = await evalTarget.evaluate(script);
                await activePage.waitForLoadState('load', { timeout: 3000 }).catch(() => { });
                const resultStr = result != null ? String(result).substring(0, 300) : '(void)';
                summary = `Evaluated JS — result: ${resultStr}`;
                break;
            }

            default:
                throw new Error(
                    `Unknown action: "${action}". Valid actions: goto, find, click, type, fill, press, select, wait_for, read, scroll, hover, back, forward, reload, new_tab, list_tabs, switch_tab, close_tab, console_messages, console_errors, aria_snapshot, frames, evaluate, screenshot, mouse_click, mouse_move, type_at`
                );
        }

        if (!hasActiveOwnedSession()) {
            const output = withLatestDownloadOutput(summary);
            return {
                ok: true,
                summary,
                output,
                metadata: buildBrowserMetadata(output, {
                    ...buildDownloadMetadata(latestDownload),
                }),
            };
        }

        const state = withLatestDownloadOutput(await getPageState(activePage));
        return {
            ok: true,
            summary,
            output: state,
            metadata: buildBrowserMetadata(state, {
                frames: collectPlaywrightFrameMetadata(activePage),
                ...buildDownloadMetadata(latestDownload),
            }),
        };

    } catch (error) {
        // On failure, return the current page state so the agent can re-observe and retry
        let recoveryState = '';
        try {
            recoveryState = '\n\nCurrent page state:\n' + await getPageState(activePage);
        } catch { /* ignore */ }

        return {
            ok: false,
            summary: `Action '${action}' failed`,
            output: error.message + recoveryState,
        };
    }
}

// ---------------------------------------------------------------------------
// browser_close
// ---------------------------------------------------------------------------

async function closeBrowserAction() {
    if (activeContext) {
        await activeContext.close().catch(() => { });
        activeContext = null;
        activePage = null;
        latestDownload = null;
        resetBrowserDiagnostics();
        return { ok: true, summary: 'Browser closed', output: 'Session ended.' };
    }
    return { ok: true, summary: 'Browser already closed', output: 'No active session.' };
}

function __setActivePageForTests(page) {
    activePage = page;
}

function __setActiveContextForTests(context) {
    activeContext = context;
}

function __setLatestDownloadForTests(download) {
    latestDownload = download;
}

module.exports = {
    launchBrowserAction,
    performBrowserAction,
    closeBrowserAction,
    __setActivePageForTests,
    __setActiveContextForTests,
    __setLatestDownloadForTests,
    formatExtensionFrames,
    formatExtensionState,
    parseBrowserOutput,
    buildBrowserMetadata,
    collectPlaywrightFrameMetadata,
};
