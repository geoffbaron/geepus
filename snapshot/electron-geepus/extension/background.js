/* background.js */
function createBridge(deps = {}) {
    const chromeApi = deps.chrome || globalThis.chrome;
    const WebSocketClass = deps.WebSocket || globalThis.WebSocket;
    const bridgeUrl = deps.bridgeUrl || 'ws://127.0.0.1:8082';
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const log = deps.log || console;
    const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
    const clearScheduled = deps.clearScheduled || ((timer) => clearTimeout(timer));
    const reconnectDelayMs = deps.reconnectDelayMs || 3000;
    const contentScriptTimeoutMs = deps.contentScriptTimeoutMs || 5000;

    let ws = null;
    let reconnectTimer = null;

    async function getActiveTab() {
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0 || !tabs[0].id) {
            throw new Error('No active tab found');
        }
        return tabs[0];
    }

    async function resolveFrameId(tabId, frameIndex) {
        if (!Number.isInteger(frameIndex) || frameIndex < 0) return undefined;
        const frames = await chromeApi.webNavigation.getAllFrames({ tabId });
        if (!Array.isArray(frames) || frames.length === 0) {
            throw new Error('No frames found for active tab');
        }
        const sorted = frames.slice().sort((a, b) => {
            if (a.frameId === 0) return -1;
            if (b.frameId === 0) return 1;
            return a.frameId - b.frameId;
        });
        const frame = sorted[frameIndex];
        if (!frame) {
            throw new Error(`Invalid frame_index ${frameIndex}; only ${sorted.length} frame(s) available`);
        }
        return frame.frameId;
    }

    function sendResponse(msg, payload, socket = ws) {
        if (!socket || typeof socket.send !== 'function') {
            throw new Error('Bridge socket is not connected');
        }
        socket.send(JSON.stringify({ id: msg.id, ...payload }));
    }

    async function listFrames(tabId) {
        const frames = await chromeApi.webNavigation.getAllFrames({ tabId });
        const sorted = (frames || []).slice().sort((a, b) => {
            if (a.frameId === 0) return -1;
            if (b.frameId === 0) return 1;
            return a.frameId - b.frameId;
        });
        return sorted.map((frame, index) => ({
            index,
            frameId: frame.frameId,
            parentFrameId: frame.parentFrameId,
            url: frame.url || '',
            errorOccurred: Boolean(frame.errorOccurred),
        }));
    }

    async function waitForTabCondition(tabId, condition = {}, timeoutMs = 15000) {
        const startedAt = Date.now();
        while ((Date.now() - startedAt) < timeoutMs) {
            const tab = await chromeApi.tabs.get(tabId);
            const url = String(tab.url || '');
            if (condition.load) {
                const desired = String(condition.load || 'complete').toLowerCase();
                const complete = String(tab.status || '').toLowerCase() === 'complete';
                if ((desired === 'load' || desired === 'complete') ? complete : complete) {
                    return `Tab load state reached: ${desired}`;
                }
            }
            if (condition.url_contains) {
                if (url.includes(String(condition.url_contains))) {
                    return `Tab URL now contains: ${condition.url_contains}`;
                }
            }
            await sleep(250);
        }
        throw new Error('Timed out waiting for tab condition');
    }

    async function dispatchToContentScript(tabId, msg, frameId) {
        return new Promise((resolve) => {
            let settled = false;
            const options = frameId !== undefined ? { frameId } : undefined;
            const timeout = schedule(() => {
                if (settled) return;
                settled = true;
                resolve({ ok: false, error: `Timed out waiting for content script after ${contentScriptTimeoutMs}ms` });
            }, contentScriptTimeoutMs);
            chromeApi.tabs.sendMessage(tabId, msg, options, (response) => {
                if (settled) return;
                settled = true;
                clearScheduled(timeout);
                if (chromeApi.runtime.lastError) {
                    resolve({ ok: false, error: chromeApi.runtime.lastError.message });
                    return;
                }
                resolve({ ok: true, output: response });
            });
        });
    }

    async function handleMessage(msg, socket = ws) {
        const activeTab = await getActiveTab();
        const activeTabId = activeTab.id;
        const exactArgs = msg.exact_args || msg.args || {};

        if (msg.action === 'goto') {
            const urlToVisit = msg.url || (msg.exact_args && (msg.exact_args.url || msg.exact_args.text));
            await chromeApi.tabs.update(activeTabId, { url: urlToVisit });
            sendResponse(msg, { ok: true, output: `Navigated to ${urlToVisit}` }, socket);
            return;
        }

        if (msg.action === 'back') {
            await chromeApi.tabs.goBack(activeTabId);
            sendResponse(msg, { ok: true, output: 'Navigated back' }, socket);
            return;
        }

        if (msg.action === 'forward') {
            await chromeApi.tabs.goForward(activeTabId);
            sendResponse(msg, { ok: true, output: 'Navigated forward' }, socket);
            return;
        }

        if (msg.action === 'reload') {
            await chromeApi.tabs.reload(activeTabId);
            sendResponse(msg, { ok: true, output: 'Reloaded page' }, socket);
            return;
        }

        if (msg.action === 'screenshot') {
            const dataUrl = await chromeApi.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
            sendResponse(msg, {
                ok: true,
                output: {
                    screenshotDataUrl: dataUrl,
                    url: activeTab.url || '',
                    title: activeTab.title || '',
                },
            }, socket);
            return;
        }

        if (msg.action === 'frames') {
            const frames = await listFrames(activeTabId);
            sendResponse(msg, { ok: true, output: frames }, socket);
            return;
        }

        if (msg.action === 'wait_for' && (exactArgs.condition?.load || exactArgs.condition?.url_contains)) {
            const output = await waitForTabCondition(activeTabId, exactArgs.condition || {}, 15000);
            sendResponse(msg, { ok: true, output }, socket);
            return;
        }

        const frameId = await resolveFrameId(activeTabId, exactArgs.frame_index);
        const response = await dispatchToContentScript(activeTabId, msg, frameId);
        sendResponse(msg, response, socket);
    }

    async function handleRawMessage(raw, socket = ws) {
        let msg;
        try {
            msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.data);
            if (!msg.action) return;
            log.log('Geepus Bridge: Received action', msg);
            await handleMessage(msg, socket);
        } catch (e) {
            log.error('Error handling message', e);
            if (msg && msg.id) {
                sendResponse(msg, { ok: false, error: e.message }, socket);
            }
        }
    }

    function connect() {
        if (ws && (ws.readyState === WebSocketClass.CONNECTING || ws.readyState === WebSocketClass.OPEN)) {
            return ws;
        }
        if (reconnectTimer) {
            clearScheduled(reconnectTimer);
            reconnectTimer = null;
        }

        log.log('Geepus Bridge: Connecting to ' + bridgeUrl);
        ws = new WebSocketClass(bridgeUrl);

        ws.onopen = () => {
            log.log('Geepus Bridge: Connected to Geepus.');
            chromeApi.action.setBadgeText({ text: 'ON' });
            chromeApi.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        };

        ws.onmessage = (event) => {
            handleRawMessage(event, ws);
        };

        ws.onclose = () => {
            log.log('Geepus Bridge: Disconnected.');
            chromeApi.action.setBadgeText({ text: 'OFF' });
            chromeApi.action.setBadgeBackgroundColor({ color: '#F44336' });
            if (!reconnectTimer) {
                reconnectTimer = schedule(() => {
                    reconnectTimer = null;
                    connect();
                }, reconnectDelayMs);
            }
        };

        ws.onerror = (e) => {
            log.error('Geepus Bridge WS error', e);
            ws.close();
        };

        return ws;
    }

    function start() {
        connect();
        chromeApi.alarms.create('keepAlive', { periodInMinutes: 1 });
        chromeApi.alarms.onAlarm.addListener(() => {
            if (ws && ws.readyState === WebSocketClass.CLOSED) {
                connect();
            }
        });
    }

    function setSocketForTests(socket) {
        ws = socket;
    }

    return {
        connect,
        start,
        handleMessage,
        handleRawMessage,
        getActiveTab,
        resolveFrameId,
        listFrames,
        waitForTabCondition,
        dispatchToContentScript,
        sendResponse,
        setSocketForTests,
        getSocket: () => ws,
        getReconnectTimer: () => reconnectTimer,
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createBridge };
} else {
    createBridge().start();
}
