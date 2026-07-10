'use strict';

/**
 * web-research.js — Structured web search + scrape-and-summarize pipeline.
 *
 * Provides a `web_search` tool the agent can call directly in plans.
 * Search backends (in priority order):
 *   1. Brave Search API   (if braveSearchApiKey is set)
 *   2. DuckDuckGo HTML    (no key required — free fallback)
 *
 * Also provides `web_scrape` to fetch and extract readable text from a URL,
 * using Node's built-in fetch + basic HTML→text extraction (no Playwright
 * overhead for simple pages).
 *
 * Depends on: settings.js (for search API key storage)
 */

const { readSettings } = require('./settings');
const path = require('path');
const { extensionBridge } = require('./extension-bridge');
const { truncate } = require('./utils');
const TurndownService = require('turndown');

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;
const MAX_SCRAPE_LENGTH = 8000;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// HTML → text extraction (lightweight, no dependencies)
// ---------------------------------------------------------------------------

function htmlToText(html) {
  let text = html;
  // Remove scripts, styles, SVGs
  text = text.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).trim() : '';
}

function extractMetaDescription(html) {
  const match = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return match ? htmlToText(match[1]).trim() : '';
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Brave Search API
// ---------------------------------------------------------------------------

async function braveSearch(query, apiKey, count = MAX_RESULTS) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, 20)));

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const results = [];

  if (data.web && Array.isArray(data.web.results)) {
    for (const item of data.web.results.slice(0, count)) {
      results.push({
        title: item.title || '',
        url: item.url || '',
        snippet: item.description || '',
        source: 'brave',
      });
    }
  }

  // Include knowledge panel if available
  if (data.infobox) {
    const infoText = [
      data.infobox.title || '',
      data.infobox.description || '',
      data.infobox.long_desc || '',
    ].filter(Boolean).join(' — ');
    if (infoText) {
      results.unshift({
        title: `[Knowledge] ${data.infobox.title || 'Info'}`,
        url: data.infobox.url || '',
        snippet: infoText.slice(0, 500),
        source: 'brave_infobox',
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML fallback (no API key needed)
// ---------------------------------------------------------------------------

async function duckDuckGoSearch(query, count = MAX_RESULTS) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search error ${response.status}`);
  }

  const html = await response.text();
  const results = [];

  // Parse result blocks from DDG HTML
  const resultMatches = html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi);
  const snippetMatches = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];

  let index = 0;
  for (const match of resultMatches) {
    if (index >= count) break;

    let href = match[1] || '';
    // DDG HTML redirects through uddg param
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      href = decodeURIComponent(uddgMatch[1]);
    }

    const title = htmlToText(match[2] || '');
    const snippet = snippetMatches[index]
      ? htmlToText(snippetMatches[index][1] || '')
      : '';

    if (href && title) {
      results.push({
        title,
        url: href,
        snippet,
        source: 'duckduckgo',
      });
    }
    index++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unified search function
// ---------------------------------------------------------------------------

/**
 * Search the web using the best available backend.
 *
 * @param {string} query     — the search query
 * @param {object} options
 *   count:          max results (default 8)
 *   braveApiKey:    Brave Search API key (from settings)
 * @returns {{ title, url, snippet, source }[]}
 */
async function webSearch(query, options = {}) {
  const count = options.count || 8;
  const braveApiKey = options.braveApiKey || '';

  // Try Brave first
  if (braveApiKey) {
    try {
      return await braveSearch(query, braveApiKey, count);
    } catch {
      // Fall through to DDG
    }
  }

  // DuckDuckGo fallback
  return duckDuckGoSearch(query, count);
}

// ---------------------------------------------------------------------------
// Firecrawl web fetch (Cloudflare / anti-bot bypass)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL using the Firecrawl v1/scrape API to bypass anti-bot
 * and return clean markdown.
 * 
 * @param {string} url 
 * @param {string} apiKey 
 */
async function firecrawlFetch(url, apiKey) {
  const reqUrl = 'https://api.firecrawl.dev/v1/scrape';
  const response = await fetchWithTimeout(reqUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      url: url,
      formats: ['markdown'],
      onlyMainContent: true
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      const errJson = await response.json();
      errorText = errJson.error || JSON.stringify(errJson);
    } catch {
      errorText = await response.text();
    }
    throw new Error(`Firecrawl API error ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  if (!json.success || !json.data) {
    throw new Error(`Firecrawl returned an unsuccessful response or missing data.`);
  }

  return {
    title: json.data.metadata?.title || '',
    url: json.data.metadata?.sourceURL || url,
    metaDescription: json.data.metadata?.description || '',
    text: json.data.markdown || '',
    bytesFetched: (json.data.markdown || '').length
  };
}

// ---------------------------------------------------------------------------
// Web scrape — fetch a URL and extract readable text
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and extract its readable text content.
 *
 * @param {string} url
 * @param {object} options
 *   maxLength:  max chars of text (default 8000)
 *   selector:   CSS selector hint (not used in fetch mode; documented for Playwright)
 * @returns {{ title, url, text, metaDescription, bytesFetched }}
 */
async function webScrape(url, options = {}) {
  const maxLength = options.maxLength || MAX_SCRAPE_LENGTH;

  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Fetch error ${response.status} for ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();

  // JSON responses — return formatted
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(body);
      const pretty = JSON.stringify(json, null, 2);
      return {
        title: url,
        url,
        text: pretty.slice(0, maxLength),
        metaDescription: '',
        bytesFetched: body.length,
      };
    } catch { /* fall through */ }
  }

  const title = extractTitle(body);
  const metaDescription = extractMetaDescription(body);
  const text = htmlToText(body);

  return {
    title: title || url,
    url,
    text: text.slice(0, maxLength),
    metaDescription,
    bytesFetched: body.length,
  };
}

// ---------------------------------------------------------------------------
// Tool execution functions (called from tools.js)
// ---------------------------------------------------------------------------

/**
 * Execute a web_search action.
 * Args: { query: string, count?: number }
 */
async function executeWebSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('web_search requires a query.');

  const settings = await readSettings();
  const braveApiKey = settings.braveSearchApiKey || '';

  const results = await webSearch(query, {
    count: args.count || 8,
    braveApiKey,
  });

  if (results.length === 0) {
    return {
      ok: true,
      summary: `Web search for "${query}" returned no results.`,
      output: 'No results found.',
      metadata: { kind: 'web_search', query },
    };
  }

  const formatted = results.map((r, i) =>
    `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
  ).join('\n\n');

  return {
    ok: true,
    summary: `Found ${results.length} results for "${query}".`,
    output: `Search results for: ${query}\n\n${formatted}`,
    metadata: { kind: 'web_search', query, resultCount: results.length },
  };
}

/**
 * Execute a web_scrape action.
 * Args: { url: string, max_length?: number }
 */
async function executeWebScrape(args) {
  const url = String(args.url || '').trim();
  if (!url) throw new Error('web_scrape requires a url.');
  if (!/^https?:\/\//i.test(url)) throw new Error('web_scrape requires an http/https URL.');

  const maxLength = args.max_length || MAX_SCRAPE_LENGTH;
  const result = await webScrape(url, { maxLength });

  return {
    ok: true,
    summary: `Scraped ${result.title} (${result.bytesFetched} bytes).`,
    output: [
      `Title: ${result.title}`,
      `URL: ${result.url}`,
      result.metaDescription ? `Description: ${result.metaDescription}` : '',
      '',
      `Content (${result.text.length} chars):`,
      result.text,
    ].filter(Boolean).join('\n'),
    metadata: {
      kind: 'web_scrape',
      url: result.url,
      title: result.title,
      bytesFetched: result.bytesFetched,
    },
  };
}

/**
 * Execute a web_fetch action.
 * Routes to Firecrawl if the API key is present. Otherwise falls back to webScrape.
 * Args: { url: string, max_length?: number, firecrawlApiKey?: string }
 */
async function executeWebFetch(args) {
  const url = String(args.url || '').trim();
  const firecrawlApiKey = String(args.firecrawlApiKey || '').trim();
  if (!url) throw new Error('web_fetch requires a url.');
  if (!/^https?:\/\//i.test(url)) throw new Error('web_fetch requires an http/https URL.');

  const maxLength = args.max_length || MAX_SCRAPE_LENGTH;
  let result;
  let backend = 'native';

  try {
    if (extensionBridge && extensionBridge.isConnected()) {
      backend = 'chrome_extension';
      const extResponse = await extensionBridge.sendAction('web_fetch', { url });

      let textContent = '';
      if (typeof extResponse === 'string') {
        textContent = extResponse;
      } else if (extResponse && extResponse.text) {
        textContent = extResponse.text;
      } else if (extResponse && extResponse.html) {
        // Fallback to html parsing if the extension only sent html
        textContent = turndownService.turndown(extResponse.html);
      }

      if (textContent.length > maxLength) {
        textContent = textContent.substring(0, maxLength) + '\\n\\n...[TRUNCATED]';
      }

      result = {
        title: '',
        url: url,
        text: textContent,
        bytesFetched: textContent.length
      };

    } else if (firecrawlApiKey) {
      backend = 'firecrawl';
      result = await firecrawlFetch(url, firecrawlApiKey);
      if (result.text.length > maxLength) {
        result.text = result.text.substring(0, maxLength) + '\\n\\n...[TRUNCATED]';
      }
    } else {
      result = await webScrape(url, { maxLength });
    }
  } catch (error) {
    throw new Error(`web_fetch failed (${backend} backend): ${error.message}`);
  }

  return {
    ok: true,
    summary: `Fetched ${result.title || url} via ${backend} backend (${result.bytesFetched} chars).`,
    output: [
      `Title: ${result.title || 'Unknown'}`,
      `URL: ${result.url}`,
      result.metaDescription ? `Description: ${result.metaDescription}` : '',
      `Backend: ${backend}`,
      '',
      `Content (${result.text.length} chars):`,
      result.text,
    ].filter(Boolean).join('\\n'),
    metadata: {
      kind: 'web_fetch',
      url: result.url,
      title: result.title,
      bytesFetched: result.bytesFetched,
      backend
    },
  };
}

module.exports = {
  htmlToText,
  extractTitle,
  extractMetaDescription,
  webSearch,
  webScrape,
  executeWebSearch,
  executeWebScrape,
  executeWebFetch,
  // Backends (exposed for testing)
  braveSearch,
  duckDuckGoSearch,
  firecrawlFetch,
};
