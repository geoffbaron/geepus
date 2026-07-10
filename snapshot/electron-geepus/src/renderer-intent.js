/**
 * renderer-intent.js — Prompt intent detection and thread-context helpers.
 *
 * Primary intent routing uses LLM classification (classifyIntent IPC).
 * These local functions serve as a SIMPLE offline fallback only.
 *
 * Design rules:
 *   - No function calls between classifier functions (no cross-dependencies,
 *     no risk of mutual recursion).
 *   - Each classifier function is fully standalone.
 *   - The local fallback is intentionally dumb: default to 'action' when unsure.
 *     The LLM handles nuanced cases; this only catches the obvious ones.
 *
 * Depends on: renderer-utils.js (shortText, setStatus, setResponse — via globals)
 */

// ---------------------------------------------------------------------------
// CONTINUATION_AFFIRMATIONS — the only prompts treated as "continue prior task"
// Must match exactly (after lowercasing and trimming).
// Deliberately short list — adding more here is a smell.
// ---------------------------------------------------------------------------
const CONTINUATION_AFFIRMATIONS = new Set([
  'proceed',
  'continue',
  'go ahead',
  'do it',
  'run it',
  'start',
  'yes',
  'y',
  'ok',
  'okay',
  'sure',
  'sounds good',
  'please proceed',
  'yes please',
  'go',
  'run',
  'do that',
  "let's go",
  'lets go',
]);

const REFERENTIAL_OBJECTIVE_PATTERN = /\b(this|that|it|same)\s+(project|task|app|issue|one)\b/i;

function isReferentialObjectivePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (REFERENTIAL_OBJECTIVE_PATTERN.test(text)) return true;
  if (/^(okay|ok|sure|great|sounds good)[,\s]+/i.test(text) && /\b(research|build|fix|continue|proceed)\b/i.test(text)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// isContinuationPrompt — is this a bare affirmation to continue a prior task?
// Standalone: does NOT call any other classifier function.
// ---------------------------------------------------------------------------
function isContinuationPrompt(prompt) {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return false;
  if (CONTINUATION_AFFIRMATIONS.has(text)) return true;
  // Mode switch phrases ("I'm in action mode") are continuations
  if (/^i(?:'m| am)\s+in\s+(?:action|research|auto)\s+mode\b/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// isReportLookupPrompt — is the user asking where a file/report was saved?
// Standalone: does NOT call any other classifier function.
// ---------------------------------------------------------------------------
function isReportLookupPrompt(prompt) {
  const text = String(prompt || '').trim().toLowerCase();
  if (!text) return false;
  if (/\b(where is|where are|where did|can't find|cant find|don't see|dont see|find the file|find the report|show me the file|show me the report)\b/.test(text)) return true;
  if (/\b(what file|which file|what path|which path|what report|where.{0,10}saved)\b/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// classifyIntentLocal — offline fallback intent classifier.
// Returns: 'question' | 'action' | 'continuation' | 'file_lookup'
//
// Only called when the LLM classifier is unavailable.
// Simple linear decision tree — no cross-calls, no recursion.
// Default is 'action' because this app is task-oriented.
// ---------------------------------------------------------------------------
function classifyIntentLocal(prompt) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();

  if (!lower) return 'question';

  // 1. Continuation — exact affirmation whitelist (standalone, no recursion risk)
  if (isContinuationPrompt(lower)) return 'continuation';

  // 2. File lookup — explicit file/path questions (standalone)
  if (isReportLookupPrompt(lower)) return 'file_lookup';

  // 3. Ends with ? AND is short — treat as conversational question
  if (lower.includes('?') && text.length < 200) return 'question';

  // 4. Default: action. Long prompts are almost always tasks.
  //    Short prompts without ? are probably commands.
  //    When unsure, the LLM would have handled it; here we just run the task.
  return 'action';
}

function recentThreadMessagesForLLM(thread, limit = 14, maxCharsPerMessage = 800) {
  const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
  return messages
    .filter((message) => message && typeof message === 'object')
    .filter((message) => (message.role === 'user' || message.role === 'assistant'))
    .filter((message) => message.technical !== true)
    .map((message) => {
      let content = String(message.content || '').trim();
      // Truncate long messages (agent reports, research results) to prevent
      // overwhelming local models with stale context
      if (content.length > maxCharsPerMessage) {
        content = content.slice(0, maxCharsPerMessage) + '...[truncated]';
      }
      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    })
    .filter((message) => message.content)
    .slice(-Math.max(1, limit));
}

function inferPriorUserObjective(thread, latestPrompt = '') {
  const skip = String(latestPrompt || '').trim().toLowerCase();
  const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const content = String(message.content || '').trim();
    if (!content) continue;
    const lower = content.toLowerCase();
    if (skip && lower === skip) continue;
    if (isContinuationPrompt(content)) continue;
    if (isReportLookupPrompt(content)) continue;
    return content;
  }
  const threadObjective = String((thread && thread.objective) || '').trim();
  return threadObjective || '';
}

function resolveExecutionTaskPrompt(thread, prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  const priorObjective = inferPriorUserObjective(thread, raw);
  if (isReferentialObjectivePrompt(raw) && priorObjective) {
    return [
      `Continue prior objective: ${priorObjective}`,
      `Latest user instruction: ${raw}`,
      'Treat these as the same thread objective and stay in-scope.',
    ].join('\n');
  }
  if (!isContinuationPrompt(raw)) {
    return raw;
  }
  if (!priorObjective) {
    return raw;
  }
  const lower = raw.toLowerCase();
  const pureContinue = CONTINUATION_AFFIRMATIONS.has(lower)
    || /^i(?:'m| am)\s+in\s+(?:action|research|auto)\s+mode\b/.test(lower);
  if (pureContinue) {
    return priorObjective;
  }

  // Check if this is likely an answer to our immediate clarifying question
  const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  if (lastAssistantMsg && String(lastAssistantMsg.content || '').trim().endsWith('?')) {
    return [
      `Prior objective: ${priorObjective}`,
      `Assistant asked: ${String(lastAssistantMsg.content || '').trim()}`,
      `User answered: ${raw}`,
      'Proceed with the objective using this new information.'
    ].join('\n');
  }

  return `${priorObjective}\n\nAdditional user direction: ${raw}`;
}

function buildThreadContextSnippet(thread, latestPrompt = '', limit = 20) {
  const skip = String(latestPrompt || '').trim().toLowerCase();
  const history = recentThreadMessagesForLLM(thread, limit)
    .filter((item) => !(item.role === 'user' && item.content.toLowerCase() === skip));
  if (history.length === 0) {
    return '';
  }
  return history
    .map((item) => `${item.role === 'assistant' ? 'Geepus' : 'User'}: ${shortText(item.content, 600)}`)
    .join('\n');
}

async function answerFromRecentArtifacts(prompt) {
  if (!isReportLookupPrompt(prompt)) {
    return false;
  }
  const artifacts = await window.geepus.listRecentArtifacts({ limit: 20 });
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    setResponse('I could not find any verified report files from recent runs.');
    setStatus('No verified report files found.');
    return true;
  }
  const lines = [
    'Here are the verified report files I found from recent runs:',
    ...artifacts.slice(0, 10).map((item) => `- ${item.path}`),
    '',
    'If you want, I can keep using these files without starting a new run.',
  ];
  setResponse(lines.join('\n'));
  setStatus('Showing verified report file paths from recent runs.');
  return true;
}
