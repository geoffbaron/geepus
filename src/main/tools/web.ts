import { classifyHttpGet } from '../policy/rules';
import type { ToolHandler } from './types';

const MAX_BODY_CHARS = 10_000;
const TIMEOUT_MS = 15_000;

export const httpGetTool: ToolHandler = {
  definition: {
    name: 'http_get',
    description: 'Fetch a URL with HTTP GET. Only allowlisted domains run automatically; anything else asks for approval.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to GET.' } },
      required: ['url'],
    },
  },
  riskTier: (args) => classifyHttpGet(String(args['url'] ?? '')),
  summarize: (args) => `GET ${String(args['url'])}`,
  execute: async (args) => {
    const url = String(args['url'] ?? '');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : text;
      return { tool: 'http_get', ok: res.ok, summary: `HTTP ${res.status} ${url}`, output: body };
    } catch (err) {
      return { tool: 'http_get', ok: false, summary: `Request failed: ${(err as Error).message}` };
    }
  },
};
