/* content.js */

function visibleText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function elementText(element) {
    if (!element) return '';
    return visibleText(
        element.getAttribute('aria-label')
        || element.innerText
        || element.textContent
        || element.value
        || element.placeholder
        || element.title
        || element.name
    );
}

function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function normalizeRole(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (['submit', 'button', 'reset'].includes(type)) return 'button';
        if (['checkbox', 'radio'].includes(type)) return type;
        return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return tag;
}

function candidateElements(root = document) {
    return Array.from(root.querySelectorAll('button, a, input, select, textarea, [role], label, [placeholder], [name], [title], [aria-label]'))
        .filter(isVisible);
}

function findLabelTarget(labelText) {
    const targetText = visibleText(labelText).toLowerCase();
    if (!targetText) return null;
    const labels = Array.from(document.querySelectorAll('label')).filter(isVisible);
    for (const label of labels) {
        const text = visibleText(label.innerText || label.textContent || label.getAttribute('aria-label'));
        if (!text || !text.toLowerCase().includes(targetText)) continue;
        const control = label.control || label.querySelector('input, textarea, select, button');
        if (control) return control;
    }
    return null;
}

function findElement(target = {}) {
    if (!target || typeof target !== 'object') return null;
    if (target.css) {
        const el = document.querySelector(target.css);
        if (el && isVisible(el)) return el;
    }
    if (target.label) {
        const labelled = findLabelTarget(target.label);
        if (labelled) return labelled;
    }

    const expectedText = visibleText(target.text || target.label || target.placeholder || target.name).toLowerCase();
    const expectedRole = visibleText(target.role).toLowerCase();
    const exact = target.exact === true;

    for (const el of candidateElements()) {
        const role = normalizeRole(el);
        if (expectedRole && role !== expectedRole) continue;

        const haystacks = [
            elementText(el),
            visibleText(el.getAttribute('placeholder')),
            visibleText(el.getAttribute('name')),
            visibleText(el.getAttribute('title')),
        ].filter(Boolean).map((item) => item.toLowerCase());

        if (!expectedText) return el;
        if (haystacks.some((item) => exact ? item === expectedText : item.includes(expectedText))) {
            return el;
        }
    }
    return null;
}

function getAriaSnapshot() {
    function traverse(node, depth = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            const txt = visibleText(node.textContent);
            if (txt) return '\n' + '  '.repeat(depth) + `- text: "${txt}"`;
            return '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return '';

        const tagName = node.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'meta', 'link'].includes(tagName)) return '';

        const role = normalizeRole(node);
        const label = visibleText(node.getAttribute('aria-label') || node.placeholder || node.title || node.alt || node.innerText);

        let output = '';
        const isInteractive = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'select', 'textarea', 'input'].includes(role) || node.hasAttribute('onclick');

        if (isInteractive || label || ['main', 'banner', 'navigation', 'region', 'heading', 'alert'].includes(role)) {
            output += '\n' + '  '.repeat(depth) + `- ${role} ${label ? `"${label.substring(0, 120)}"` : ''}`;
        }

        for (const child of node.childNodes) {
            output += traverse(child, isInteractive || label ? depth + 1 : depth);
        }
        return output;
    }

    return 'Accessibility Tree:' + traverse(document.body);
}

function getState() {
    return `URL: ${window.location.href}\nTitle: ${document.title}\n\n${getAriaSnapshot()}`;
}

function performRead(args = {}) {
    const query = args.query || args;
    if (query === 'url' || query.url) return `URL: ${window.location.href}`;
    if (query === 'title' || query.title) return `Title: ${document.title}`;
    if (query.attr && args.target) {
        const el = findElement(args.target);
        if (!el) throw new Error(`Could not find element for read: ${JSON.stringify(args.target)}`);
        return el.getAttribute(query.attr) || el.value || '(empty)';
    }
    return visibleText(document.body.innerText).substring(0, 15000);
}

function performClick(args = {}) {
    const el = findElement(args.target || args);
    if (!el) throw new Error(`Could not find element to click matching: ${JSON.stringify(args.target || args)}`);
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.click();
    return `Clicked ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performType(args = {}) {
    const el = findElement(args.target || args);
    if (!el) throw new Error(`Could not find element to type in matching: ${JSON.stringify(args.target || args)}`);
    const value = String(args.value ?? args.text ?? '');
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    if ('value' in el) {
        el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Typed "${value}" into ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performPress(args = {}) {
    const key = String(args.key || 'Enter');
    const el = document.activeElement || document.body;
    const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true });
    el.dispatchEvent(event);
    if (key === 'Enter') {
        if (el.tagName === 'FORM') el.submit();
        else if (el.form) el.form.submit();
    }
    return `Pressed key: ${key}`;
}

function performSelect(args = {}) {
    const el = findElement(args.target || args);
    if (!el) throw new Error(`Could not find select element matching: ${JSON.stringify(args.target || args)}`);
    const value = String(args.value ?? args.text ?? '');
    if (el.tagName.toLowerCase() !== 'select') {
        throw new Error('Target element is not a select.');
    }
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected "${value}"`;
}

function performHover(args = {}) {
    const el = findElement(args.target || args);
    if (!el) throw new Error(`Could not find element to hover matching: ${JSON.stringify(args.target || args)}`);
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return `Hovered ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performScroll(args = {}) {
    const direction = String(args.direction || 'down').toLowerCase();
    window.scrollBy(0, direction === 'up' ? -500 : 500);
    return `Scrolled ${direction}`;
}

function elementAtPoint(x, y) {
    const el = document.elementFromPoint(Number(x), Number(y));
    if (!el) throw new Error(`No element found at coordinates (${x}, ${y})`);
    return el;
}

function performMouseClick(args = {}) {
    const x = Number(args.x);
    const y = Number(args.y);
    const el = elementAtPoint(x, y);
    ['mousemove', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: y,
            view: window,
        }));
    });
    if (typeof el.click === 'function') el.click();
    return `Clicked at (${x}, ${y}) on ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performMouseMove(args = {}) {
    const x = Number(args.x);
    const y = Number(args.y);
    const el = elementAtPoint(x, y);
    ['mousemove', 'mouseover', 'mouseenter'].forEach((type) => {
        el.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: y,
            view: window,
        }));
    });
    return `Moved mouse to (${x}, ${y}) over ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performTypeAt(args = {}) {
    const x = Number(args.x);
    const y = Number(args.y);
    const text = String(args.text ?? '');
    const el = elementAtPoint(x, y);
    if (typeof el.focus === 'function') el.focus();
    if ('value' in el) {
        el.value = text;
    }
    el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: x,
        clientY: y,
        view: window,
    }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Clicked (${x}, ${y}) and typed "${text}" into ${normalizeRole(el)} "${elementText(el).substring(0, 80)}"`;
}

function performEvaluate() {
    throw new Error('Raw JS evaluation is blocked in the Chrome Extension bridge for security.');
}

function handleBrowserAction(action, args = {}) {
    switch (action) {
        case 'read':
            return performRead(args);
        case 'aria_snapshot':
            return getState();
        case 'click':
            return performClick(args);
        case 'type':
        case 'fill':
            return performType(args);
        case 'press':
            return performPress(args);
        case 'select':
            return performSelect(args);
        case 'hover':
            return performHover(args);
        case 'scroll':
            return performScroll(args);
        case 'mouse_click':
            return performMouseClick(args);
        case 'mouse_move':
            return performMouseMove(args);
        case 'type_at':
            return performTypeAt(args);
        case 'evaluate':
            return performEvaluate();
        default:
            throw new Error(`Unsupported browser action: ${action}`);
    }
}

function waitForCondition(args = {}) {
    const condition = args.condition || args || {};
    const timeoutMs = Math.min(Number(condition.timeout_ms || args.timeout_ms || 10000), 15000);
    if (condition.ms) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(`Waited ${condition.ms}ms`), Math.min(Number(condition.ms), timeoutMs));
        });
    }
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            try {
                if (condition.text) {
                    const bodyText = visibleText(document.body && document.body.innerText);
                    if (bodyText.includes(String(condition.text))) {
                        clearInterval(timer);
                        resolve(`Text appeared on page: "${condition.text}"`);
                        return;
                    }
                } else if (condition.element) {
                    const el = findElement(condition.element);
                    if (el) {
                        clearInterval(timer);
                        resolve(`Element became visible: ${JSON.stringify(condition.element)}`);
                        return;
                    }
                } else {
                    clearInterval(timer);
                    resolve(getState());
                    return;
                }
                if ((Date.now() - startedAt) >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error('Timed out waiting for DOM condition'));
                }
            } catch (error) {
                clearInterval(timer);
                reject(error);
            }
        }, 200);
    });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === 'web_fetch') {
                const text = document.body.innerText || '';
                const mainContent = document.querySelector('main, article, [role="main"]') || document.body;
                sendResponse({ html: mainContent.innerHTML, text: text.substring(0, 15000) });
                return true;
            }

            if (request.action === 'ping') {
                sendResponse('pong');
                return true;
            }

            const args = request.exact_args || request.args || {};
            const action = args.action || request.action;
            if (action === 'wait_for') {
                waitForCondition(args)
                    .then((result) => sendResponse(result))
                    .catch((error) => sendResponse({ error: `Extension error: ${error.message}` }));
                return true;
            }
            const result = handleBrowserAction(action, args);
            sendResponse(result);
        } catch (e) {
            sendResponse({ error: `Extension error: ${e.message}` });
        }
        return true;
    });
}

if (typeof module !== 'undefined') {
    module.exports = {
        visibleText,
        normalizeRole,
        findElement,
        handleBrowserAction,
        waitForCondition,
    };
}
