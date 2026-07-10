'use strict';

/**
 * integrations.js — External service integrations for Geepus.
 *
 * Provides:
 *   - GitHub API: issues, PRs, CI status, review comments
 *   - Git push (gated): with explicit per-run approval
 *   - Slack/Discord webhooks: post status updates
 *   - Email digest: daily/weekly summaries via SMTP or HTTP API
 *   - HTTP fetch (safe subset): GET requests to known-safe domains
 *
 * Depends on: settings.js, utils.js, notifications.js, run-state.js
 */

const { readSettings } = require('./settings');
const { truncate, ensureObject } = require('./utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Geepus/1.0';

const SAFE_FETCH_DOMAINS = new Set([
  'api.github.com',
  'registry.npmjs.org',
  'pypi.org',
  'crates.io',
  'pkg.go.dev',
  'docs.rs',
  'developer.mozilla.org',
  'devdocs.io',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'httpbin.org',
]);

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...options.headers,
      },
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) {
      const msg = typeof data === 'object' && data.message ? data.message : text.slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...options.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Safe HTTP Fetch (GET only, known domains)
// ---------------------------------------------------------------------------

function isDomainSafe(urlString) {
  try {
    const parsed = new URL(urlString);
    return SAFE_FETCH_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function safeFetch(url) {
  if (!isDomainSafe(url)) {
    throw new Error(
      `Domain not in safe list. Allowed: ${[...SAFE_FETCH_DOMAINS].join(', ')}`
    );
  }
  return fetchText(url, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function parseRepo(repoString) {
  const parts = String(repoString || '').trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format. Expected "owner/repo", got: "${repoString}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

async function githubListIssues(token, repo, options = {}) {
  const { owner, repo: repoName } = parseRepo(repo);
  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  if (options.labels) params.set('labels', options.labels);
  if (options.assignee) params.set('assignee', options.assignee);
  params.set('per_page', String(Math.min(Number(options.per_page) || 30, 100)));
  params.set('sort', options.sort || 'updated');

  const url = `https://api.github.com/repos/${owner}/${repoName}/issues?${params.toString()}`;
  const issues = await fetchJSON(url, { headers: githubHeaders(token) });
  return issues.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    labels: (i.labels || []).map((l) => l.name),
    assignees: (i.assignees || []).map((a) => a.login),
    created_at: i.created_at,
    updated_at: i.updated_at,
    url: i.html_url,
    is_pull_request: Boolean(i.pull_request),
    body_preview: truncate(i.body || '', 300),
  }));
}

async function githubGetIssue(token, repo, issueNumber) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}`;
  const i = await fetchJSON(url, { headers: githubHeaders(token) });
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    body: i.body || '',
    labels: (i.labels || []).map((l) => l.name),
    assignees: (i.assignees || []).map((a) => a.login),
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    url: i.html_url,
    is_pull_request: Boolean(i.pull_request),
  };
}

async function githubCreateIssue(token, repo, { title, body, labels, assignees }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues`;
  return fetchJSON(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: String(title || ''),
      body: String(body || ''),
      labels: Array.isArray(labels) ? labels : [],
      assignees: Array.isArray(assignees) ? assignees : [],
    }),
  });
}

async function githubCreatePR(token, repo, { title, head, base, body, draft }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls`;
  const pr = await fetchJSON(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: String(title || ''),
      head: String(head || ''),
      base: String(base || 'main'),
      body: String(body || ''),
      draft: draft !== false,
    }),
  });
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.html_url,
    head: pr.head?.ref,
    base: pr.base?.ref,
    draft: pr.draft,
  };
}

async function githubGetPR(token, repo, prNumber) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`;
  const pr = await fetchJSON(url, { headers: githubHeaders(token) });
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    body: pr.body || '',
    url: pr.html_url,
    head: pr.head?.ref,
    base: pr.base?.ref,
    draft: pr.draft,
    mergeable: pr.mergeable,
    merged: pr.merged,
    review_comments: pr.review_comments,
    commits: pr.commits,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
  };
}

async function githubListPRReviewComments(token, repo, prNumber) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/comments?per_page=50`;
  const comments = await fetchJSON(url, { headers: githubHeaders(token) });
  return comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line || c.original_line,
    body: c.body,
    user: c.user?.login,
    created_at: c.created_at,
  }));
}

async function githubReplyToReviewComment(token, repo, prNumber, { comment_id, body }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/comments/${comment_id}/replies`;
  return fetchJSON(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: String(body || '') }),
  });
}

async function githubGetCIStatus(token, repo, ref) {
  const { owner, repo: repoName } = parseRepo(repo);
  // Use check-runs API (GitHub Actions / Checks)
  const url = `https://api.github.com/repos/${owner}/${repoName}/commits/${ref || 'HEAD'}/check-runs?per_page=50`;
  const data = await fetchJSON(url, { headers: githubHeaders(token) });
  const runs = (data.check_runs || []).map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    started_at: r.started_at,
    completed_at: r.completed_at,
    url: r.html_url,
  }));
  // Also get combined commit status
  const statusUrl = `https://api.github.com/repos/${owner}/${repoName}/commits/${ref || 'HEAD'}/status`;
  let combinedState = 'unknown';
  try {
    const statusData = await fetchJSON(statusUrl, { headers: githubHeaders(token) });
    combinedState = statusData.state || 'unknown';
  } catch { /* ignore */ }
  return { combined_state: combinedState, check_runs: runs };
}

async function githubAddComment(token, repo, issueNumber, body) {
  const { owner, repo: repoName } = parseRepo(repo);
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`;
  return fetchJSON(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: String(body || '') }),
  });
}

// ---------------------------------------------------------------------------
// Git Push (gated — requires explicit per-run approval)
// ---------------------------------------------------------------------------

/** Track which runIds have been approved for push this session. */
const pushApprovedRuns = new Set();

function approvePushForRun(runId) {
  if (!runId) throw new Error('runId is required to approve git push.');
  pushApprovedRuns.add(runId);
}

function revokePushApproval(runId) {
  pushApprovedRuns.delete(runId);
}

function isPushApproved(runId) {
  return pushApprovedRuns.has(runId);
}

// ---------------------------------------------------------------------------
// Slack / Discord webhooks
// ---------------------------------------------------------------------------

async function postSlackWebhook(webhookUrl, { text, blocks }) {
  if (!/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
    throw new Error('Invalid Slack webhook URL.');
  }
  const payload = {};
  if (text) payload.text = String(text);
  if (Array.isArray(blocks)) payload.blocks = blocks;

  await fetchJSON(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: true, destination: 'slack' };
}

async function postDiscordWebhook(webhookUrl, { content, embeds }) {
  if (!/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(webhookUrl)) {
    throw new Error('Invalid Discord webhook URL.');
  }
  const payload = {};
  if (content) payload.content = String(content).slice(0, 2000);
  if (Array.isArray(embeds)) payload.embeds = embeds.slice(0, 10);

  await fetchJSON(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: true, destination: 'discord' };
}

/**
 * Post a status update to the configured webhook (Slack or Discord).
 * Auto-detects destination from URL pattern.
 */
async function postStatusWebhook(webhookUrl, message) {
  const url = String(webhookUrl || '').trim();
  if (!url) throw new Error('No webhook URL configured.');

  if (/hooks\.slack\.com/.test(url)) {
    return postSlackWebhook(url, { text: message });
  }
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) {
    return postDiscordWebhook(url, { content: message });
  }
  throw new Error('Webhook URL not recognized as Slack or Discord.');
}

// ---------------------------------------------------------------------------
// Email digest (via SMTP relay or HTTP API)
// ---------------------------------------------------------------------------

/**
 * Send an email via a simple SMTP-over-HTTP relay or configured API.
 * Supports generic HTTP POST APIs that accept { to, subject, body } JSON.
 *
 * For full SMTP, the user should configure an external relay or use
 * something like SendGrid/Mailgun/Postmark API endpoint.
 */
async function sendEmailDigest({ apiUrl, apiKey, to, subject, body }) {
  if (!apiUrl) throw new Error('Email API URL not configured.');
  if (!to) throw new Error('Email recipient not configured.');

  const url = String(apiUrl).trim();
  const headers = {
    'Content-Type': 'application/json',
  };

  // Support common email API patterns
  if (apiKey) {
    if (/api\.sendgrid\.com/.test(url)) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      const payload = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: 'geepus@noreply.local' },
        subject: String(subject || 'Geepus Digest'),
        content: [{ type: 'text/plain', value: String(body || '') }],
      };
      await fetchJSON(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      return { ok: true, to, provider: 'sendgrid' };
    }

    if (/api\.mailgun\.net/.test(url)) {
      // Mailgun uses form encoding with Basic auth
      const formData = new URLSearchParams();
      formData.set('from', 'Geepus <geepus@noreply.local>');
      formData.set('to', to);
      formData.set('subject', String(subject || 'Geepus Digest'));
      formData.set('text', String(body || ''));
      await fetchText(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
        },
        body: formData.toString(),
      });
      return { ok: true, to, provider: 'mailgun' };
    }

    // Generic API with Bearer token
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Generic JSON endpoint
  await fetchJSON(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to,
      subject: String(subject || 'Geepus Digest'),
      body: String(body || ''),
    }),
  });
  return { ok: true, to, provider: 'generic' };
}

// ---------------------------------------------------------------------------
// Unified integration dispatcher (for agent tool calls)
// ---------------------------------------------------------------------------

async function executeIntegrationAction(tool, args) {
  const settings = await readSettings();
  const integrations = ensureObject(settings.integrations);

  switch (tool) {
    // --- GitHub ---
    case 'github_list_issues': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured. Add it in Settings → Integrations.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubListIssues(token, repo, args);
    }
    case 'github_get_issue': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubGetIssue(token, repo, args.issue_number);
    }
    case 'github_create_issue': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubCreateIssue(token, repo, args);
    }
    case 'github_create_pr': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubCreatePR(token, repo, args);
    }
    case 'github_get_pr': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubGetPR(token, repo, args.pr_number);
    }
    case 'github_pr_comments': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubListPRReviewComments(token, repo, args.pr_number);
    }
    case 'github_reply_review': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubReplyToReviewComment(token, repo, args.pr_number, args);
    }
    case 'github_ci_status': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubGetCIStatus(token, repo, args.ref);
    }
    case 'github_add_comment': {
      const token = integrations.githubToken;
      if (!token) throw new Error('GitHub token not configured.');
      const repo = String(args.repo || integrations.githubDefaultRepo || '');
      return githubAddComment(token, repo, args.issue_number, args.body);
    }

    // --- Webhooks ---
    case 'notify_webhook': {
      const webhookUrl = args.webhook_url || integrations.webhookUrl;
      return postStatusWebhook(webhookUrl, String(args.message || ''));
    }

    // --- Email ---
    case 'send_email': {
      return sendEmailDigest({
        apiUrl: integrations.emailApiUrl,
        apiKey: integrations.emailApiKey,
        to: args.to || integrations.emailTo,
        subject: args.subject,
        body: args.body,
      });
    }

    // --- Safe HTTP GET ---
    case 'http_get': {
      const text = await safeFetch(String(args.url || ''));
      return {
        ok: true,
        summary: `Fetched ${args.url}`,
        output: truncate(text, 12000),
      };
    }

    default:
      throw new Error(`Unknown integration tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // GitHub
  githubListIssues,
  githubGetIssue,
  githubCreateIssue,
  githubCreatePR,
  githubGetPR,
  githubListPRReviewComments,
  githubReplyToReviewComment,
  githubGetCIStatus,
  githubAddComment,

  // Git push gating
  approvePushForRun,
  revokePushApproval,
  isPushApproved,
  pushApprovedRuns,

  // Webhooks
  postSlackWebhook,
  postDiscordWebhook,
  postStatusWebhook,

  // Email
  sendEmailDigest,

  // Safe HTTP
  safeFetch,
  isDomainSafe,
  SAFE_FETCH_DOMAINS,

  // Unified dispatcher
  executeIntegrationAction,
};
