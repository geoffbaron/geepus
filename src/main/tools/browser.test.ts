import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const goto = vi.fn();
const find = vi.fn();
const click = vi.fn();
const type = vi.fn();
const selectOption = vi.fn();
const waitFor = vi.fn();
const read = vi.fn();
const scroll = vi.fn();

vi.mock('../browser/instance', () => ({
  getBrowserSession: () => ({ goto, find, click, type, selectOption, waitFor, read, scroll }),
}));

import {
  BROWSER_TOOLS,
  browserClickTool,
  browserFindTool,
  browserGotoTool,
  browserReadTool,
  browserScrollTool,
  browserSelectTool,
  browserTypeTool,
  browserWaitForTool,
} from './browser';

const ctx = { workspaceRoot: '/tmp/ws' };

describe('browser tools', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('BROWSER_TOOLS contains exactly the 8 primitives', () => {
    expect(BROWSER_TOOLS.map((t) => t.definition.name).sort()).toEqual([
      'browser_click',
      'browser_find',
      'browser_goto',
      'browser_read',
      'browser_scroll',
      'browser_select',
      'browser_type',
      'browser_wait_for',
    ]);
  });

  describe('risk tiers', () => {
    it('navigation/observation tools are always read tier', () => {
      expect(browserFindTool.riskTier({ target: {} }, ctx)).toBe('read');
      expect(browserReadTool.riskTier({}, ctx)).toBe('read');
      expect(browserScrollTool.riskTier({ direction: 'down' }, ctx)).toBe('read');
      expect(browserWaitForTool.riskTier({ text: 'Done' }, ctx)).toBe('read');
    });

    it('click on an ordinary target is write tier', () => {
      expect(browserClickTool.riskTier({ target: { text: 'Next' } }, ctx)).toBe('write');
    });

    it('click on a checkout-shaped target is sensitive tier', () => {
      expect(browserClickTool.riskTier({ target: { text: 'Place Order' } }, ctx)).toBe('sensitive');
    });

    it('type/select follow the same checkout-shaped classification as click', () => {
      expect(browserTypeTool.riskTier({ target: { text: 'Confirm Purchase' }, text: 'x' }, ctx)).toBe('sensitive');
      expect(browserSelectTool.riskTier({ target: { label: 'Quantity' }, value: '2' }, ctx)).toBe('write');
    });

    it('goto an allowlisted domain is read tier, others are write', () => {
      expect(browserGotoTool.riskTier({ url: 'https://en.wikipedia.org/wiki/Test' }, ctx)).toBe('read');
      expect(browserGotoTool.riskTier({ url: 'https://some-shop.example.com' }, ctx)).toBe('write');
    });
  });

  describe('execute', () => {
    it('browser_goto calls session.goto and returns its output', async () => {
      goto.mockResolvedValue('URL: https://example.com\nTitle: Example');
      const result = await browserGotoTool.execute({ url: 'https://example.com' }, ctx);
      expect(goto).toHaveBeenCalledWith('https://example.com');
      expect(result.ok).toBe(true);
      expect(result.output).toContain('Example');
    });

    it('browser_click passes the target through to session.click', async () => {
      click.mockResolvedValue('URL: https://example.com/cart');
      const target = { role: 'button', text: 'Add to Cart' };
      const result = await browserClickTool.execute({ target }, ctx);
      expect(click).toHaveBeenCalledWith(target);
      expect(result.ok).toBe(true);
    });

    it('returns ok:false (not a throw) when the session rejects', async () => {
      click.mockRejectedValue(new Error('element not found'));
      const result = await browserClickTool.execute({ target: { text: 'Missing' } }, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('element not found');
    });

    it('browser_type forwards both target and text', async () => {
      type.mockResolvedValue('URL: https://example.com');
      await browserTypeTool.execute({ target: { label: 'Email' }, text: 'me@example.com' }, ctx);
      expect(type).toHaveBeenCalledWith({ label: 'Email' }, 'me@example.com');
    });

    it('browser_select forwards target and value', async () => {
      selectOption.mockResolvedValue('URL: https://example.com');
      await browserSelectTool.execute({ target: { label: 'Size' }, value: 'M' }, ctx);
      expect(selectOption).toHaveBeenCalledWith({ label: 'Size' }, 'M');
    });

    it('browser_wait_for forwards urlContains and text', async () => {
      waitFor.mockResolvedValue('URL: https://example.com/done');
      await browserWaitForTool.execute({ urlContains: '/done' }, ctx);
      expect(waitFor).toHaveBeenCalledWith({ urlContains: '/done', text: undefined });
    });

    it('browser_scroll defaults to "down" for an invalid direction', async () => {
      scroll.mockResolvedValue('scrolled');
      await browserScrollTool.execute({ direction: 'sideways' }, ctx);
      expect(scroll).toHaveBeenCalledWith('down');
    });

    it('browser_read takes no arguments', async () => {
      read.mockResolvedValue('URL: https://example.com');
      const result = await browserReadTool.execute({}, ctx);
      expect(result.ok).toBe(true);
    });

    it('browser_find reports how many elements matched', async () => {
      find.mockResolvedValue('Found 1 matching element(s). First: "Sign up"');
      const result = await browserFindTool.execute({ target: { role: 'button', text: 'Sign up' } }, ctx);
      expect(result.output).toContain('Sign up');
    });
  });
});
