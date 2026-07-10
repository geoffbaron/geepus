'use strict';

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncate(text, maxLength = 8000) {
  const value = String(text || '');
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function normalizeRisk(rawRisk) {
  const value = String(rawRisk || '').toLowerCase();
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
}

function stripThinkTags(text) {
  // Qwen3 and other reasoning models wrap output in <think>...</think> blocks.
  // Strip these so extractFirstJSONObject grabs the real response JSON, not a
  // partial JSON fragment the model was "thinking about".
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractFirstJSONObject(text) {
  const input = stripThinkTags(String(text || ''));
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  // Track opening delimiters for repair: '{' or '['
  const delimStack = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
        delimStack.push('{');
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      delimStack.push('{');
    } else if (char === '[') {
      delimStack.push('[');
    } else if (char === '}') {
      depth -= 1;
      // Pop until we find the matching '{'
      while (delimStack.length > 0 && delimStack[delimStack.length - 1] !== '{') {
        delimStack.pop();
      }
      if (delimStack.length > 0) delimStack.pop(); // pop the '{'
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    } else if (char === ']') {
      // Pop until we find the matching '['
      while (delimStack.length > 0 && delimStack[delimStack.length - 1] !== '[') {
        delimStack.pop();
      }
      if (delimStack.length > 0) delimStack.pop(); // pop the '['
    }
  }

  // ── Truncated JSON repair ──────────────────────────────────────────────
  // If we found a '{' but never reached depth 0, the response was likely
  // truncated by the provider's max_tokens limit.  Use the delimiter stack
  // to close open strings / arrays / objects so JSON.parse can salvage the plan.
  if (start !== -1 && depth > 0) {
    let repaired = input.slice(start);
    // Close an open string
    if (inString) {
      repaired += '"';
    }
    // Close delimiters from innermost to outermost using the stack
    for (let i = delimStack.length - 1; i >= 0; i -= 1) {
      repaired += delimStack[i] === '{' ? '}' : ']';
    }

    // Validate that our repair produced parseable JSON
    try {
      JSON.parse(repaired);
      console.log('[utils] Repaired truncated JSON (depth was', depth, ', inString:', inString, ')');
      return repaired;
    } catch (_e) {
      // Repair didn't work — fall through to null
      console.log('[utils] JSON repair failed:', _e.message);
    }
  }

  return null;
}

function extractJSONObjects(text) {
  const input = stripThinkTags(String(text || ''));
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  const delimStack = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (start === -1) {
      if (char === '{' || char === '[') {
        start = index;
        depth = 1;
        delimStack.push(char);
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      delimStack.push('{');
    } else if (char === '[') {
      depth += 1;
      delimStack.push('[');
    } else if (char === '}') {
      depth -= 1;
      while (delimStack.length > 0 && delimStack[delimStack.length - 1] !== '{') delimStack.pop();
      if (delimStack.length > 0) delimStack.pop();
      if (depth === 0) {
        objects.push(input.slice(start, index + 1));
        start = -1;
      }
    } else if (char === ']') {
      depth -= 1;
      while (delimStack.length > 0 && delimStack[delimStack.length - 1] !== '[') delimStack.pop();
      if (delimStack.length > 0) delimStack.pop();
      if (depth === 0) {
        objects.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }

  // Handle truncated JSON for the last object
  if (start !== -1 && depth > 0) {
    let repaired = input.slice(start);
    if (inString) repaired += '"';
    for (let i = delimStack.length - 1; i >= 0; i -= 1) {
      repaired += delimStack[i] === '{' ? '}' : ']';
    }
    try {
      JSON.parse(repaired);
      objects.push(repaired);
    } catch (_e) {
      // Repair failed, ignore
    }
  }

  return objects;
}

/**
 * Escape literal control characters (newlines, tabs, carriage returns) that
 * appear inside JSON string values. LLMs sometimes embed real newlines in string
 * fields which breaks JSON.parse even though the rest of the structure is valid.
 */
function sanitizeJsonString(text) {
  let result = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        result += ch;
      } else if (ch === '\\') {
        esc = true;
        result += ch;
      } else if (ch === '"') {
        inStr = false;
        result += ch;
      } else if (ch === '\n') {
        result += '\\n';
      } else if (ch === '\r') {
        result += '\\r';
      } else if (ch === '\t') {
        result += '\\t';
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') inStr = true;
      result += ch;
    }
  }
  return result;
}

function isLikelyRefusal(text) {
  const value = String(text || '').toLowerCase();
  const phrases = [
    "i'm unable",
    'i am unable',
    'as an ai',
    'i do not have access',
    'i don\'t have access',
    'i can guide you',
  ];
  return phrases.some((phrase) => value.includes(phrase));
}

module.exports = {
  ensureObject,
  clampNumber,
  truncate,
  normalizeRisk,
  stripThinkTags,
  extractFirstJSONObject,
  extractJSONObjects,
  sanitizeJsonString,
  isLikelyRefusal,
};
