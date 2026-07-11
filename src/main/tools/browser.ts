import type { BrowserTarget } from '@shared/browser';
import { getBrowserSession } from '../browser/instance';
import { classifyBrowserInteraction, isHttpAllowlisted } from '../policy/rules';
import type { ToolHandler } from './types';

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', description: 'ARIA role, e.g. "button", "link", "textbox".' },
    label: { type: 'string' },
    placeholder: { type: 'string' },
    text: { type: 'string', description: 'Visible text to match.' },
    name: { type: 'string', description: 'The name= attribute.' },
    css: { type: 'string' },
    exact: { type: 'boolean' },
  },
};

function asTarget(args: Record<string, unknown>): BrowserTarget {
  const target = args['target'];
  return target && typeof target === 'object' ? (target as BrowserTarget) : {};
}

function summarizeTarget(target: BrowserTarget): string {
  return target.text ?? target.label ?? target.role ?? target.css ?? target.name ?? JSON.stringify(target);
}

export const browserGotoTool: ToolHandler = {
  definition: {
    name: 'browser_goto',
    description: 'Navigate the browser to a URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  riskTier: (args) => (isHttpAllowlisted(String(args['url'] ?? '')) ? 'read' : 'write'),
  summarize: (args) => `Go to ${String(args['url'])}`,
  execute: async (args) => {
    const url = String(args['url'] ?? '');
    try {
      const output = await getBrowserSession().goto(url);
      return { tool: 'browser_goto', ok: true, summary: `Navigated to ${url}`, output };
    } catch (err) {
      return { tool: 'browser_goto', ok: false, summary: `Failed to navigate: ${(err as Error).message}` };
    }
  },
};

export const browserFindTool: ToolHandler = {
  definition: {
    name: 'browser_find',
    description: 'Find an element on the current page by semantic query (role/label/placeholder/text/name/css).',
    parameters: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'] },
  },
  riskTier: () => 'read',
  summarize: (args) => `Find ${summarizeTarget(asTarget(args))}`,
  execute: async (args) => {
    try {
      const output = await getBrowserSession().find(asTarget(args));
      return { tool: 'browser_find', ok: true, summary: 'Searched for element', output };
    } catch (err) {
      return { tool: 'browser_find', ok: false, summary: `Find failed: ${(err as Error).message}` };
    }
  },
};

export const browserClickTool: ToolHandler = {
  definition: {
    name: 'browser_click',
    description: 'Click an element on the current page.',
    parameters: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'] },
  },
  riskTier: (args) => classifyBrowserInteraction(asTarget(args)),
  summarize: (args) => `Click ${summarizeTarget(asTarget(args))}`,
  execute: async (args) => {
    try {
      const output = await getBrowserSession().click(asTarget(args));
      return { tool: 'browser_click', ok: true, summary: `Clicked ${summarizeTarget(asTarget(args))}`, output };
    } catch (err) {
      return { tool: 'browser_click', ok: false, summary: `Click failed: ${(err as Error).message}` };
    }
  },
};

export const browserTypeTool: ToolHandler = {
  definition: {
    name: 'browser_type',
    description: 'Type text into an element (e.g. a text input) on the current page.',
    parameters: {
      type: 'object',
      properties: { target: TARGET_SCHEMA, text: { type: 'string' } },
      required: ['target', 'text'],
    },
  },
  riskTier: (args) => classifyBrowserInteraction(asTarget(args)),
  summarize: (args) => `Type into ${summarizeTarget(asTarget(args))}`,
  execute: async (args) => {
    try {
      const output = await getBrowserSession().type(asTarget(args), String(args['text'] ?? ''));
      return { tool: 'browser_type', ok: true, summary: `Typed into ${summarizeTarget(asTarget(args))}`, output };
    } catch (err) {
      return { tool: 'browser_type', ok: false, summary: `Type failed: ${(err as Error).message}` };
    }
  },
};

export const browserSelectTool: ToolHandler = {
  definition: {
    name: 'browser_select',
    description: 'Select an option in a dropdown/select element on the current page.',
    parameters: {
      type: 'object',
      properties: { target: TARGET_SCHEMA, value: { type: 'string' } },
      required: ['target', 'value'],
    },
  },
  riskTier: (args) => classifyBrowserInteraction(asTarget(args)),
  summarize: (args) => `Select "${String(args['value'])}" in ${summarizeTarget(asTarget(args))}`,
  execute: async (args) => {
    try {
      const output = await getBrowserSession().selectOption(asTarget(args), String(args['value'] ?? ''));
      return { tool: 'browser_select', ok: true, summary: 'Selected option', output };
    } catch (err) {
      return { tool: 'browser_select', ok: false, summary: `Select failed: ${(err as Error).message}` };
    }
  },
};

export const browserWaitForTool: ToolHandler = {
  definition: {
    name: 'browser_wait_for',
    description: 'Wait for the URL to contain a substring, or for text to appear on the page.',
    parameters: {
      type: 'object',
      properties: { urlContains: { type: 'string' }, text: { type: 'string' } },
    },
  },
  riskTier: () => 'read',
  summarize: (args) => `Wait for ${String(args['urlContains'] ?? args['text'] ?? 'condition')}`,
  execute: async (args) => {
    try {
      const output = await getBrowserSession().waitFor({
        urlContains: args['urlContains'] ? String(args['urlContains']) : undefined,
        text: args['text'] ? String(args['text']) : undefined,
      });
      return { tool: 'browser_wait_for', ok: true, summary: 'Condition met', output };
    } catch (err) {
      return { tool: 'browser_wait_for', ok: false, summary: `Timed out waiting: ${(err as Error).message}` };
    }
  },
};

export const browserReadTool: ToolHandler = {
  definition: {
    name: 'browser_read',
    description: "Read the current page's URL, title, and accessibility tree.",
    parameters: { type: 'object', properties: {} },
  },
  riskTier: () => 'read',
  summarize: () => 'Read current page state',
  execute: async () => {
    try {
      const output = await getBrowserSession().read();
      return { tool: 'browser_read', ok: true, summary: 'Read page state', output };
    } catch (err) {
      return { tool: 'browser_read', ok: false, summary: `Read failed: ${(err as Error).message}` };
    }
  },
};

export const browserScrollTool: ToolHandler = {
  definition: {
    name: 'browser_scroll',
    description: 'Scroll the current page up or down.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] } },
      required: ['direction'],
    },
  },
  riskTier: () => 'read',
  summarize: (args) => `Scroll ${String(args['direction'])}`,
  execute: async (args) => {
    const direction = args['direction'] === 'up' ? 'up' : 'down';
    try {
      const output = await getBrowserSession().scroll(direction);
      return { tool: 'browser_scroll', ok: true, summary: `Scrolled ${direction}`, output };
    } catch (err) {
      return { tool: 'browser_scroll', ok: false, summary: `Scroll failed: ${(err as Error).message}` };
    }
  },
};

export const BROWSER_TOOLS: ToolHandler[] = [
  browserGotoTool,
  browserFindTool,
  browserClickTool,
  browserTypeTool,
  browserSelectTool,
  browserWaitForTool,
  browserReadTool,
  browserScrollTool,
];
